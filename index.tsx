import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Modality, Type } from '@google/genai';

const BRAND_NAME = "West LA Computer Expert";
const BUSINESS_PHONE = "310-850-8093";
const WEBSITE = "https://get-techsupportla.com/";
const OWNER_NAME = "Daniel Zivetz";

const SYSTEM_INSTRUCTION = "Helpful.";
const TRIAGE_TOOL = null;

const App = () => {
  const [status, setStatus] = useState('IDLE');
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({ clientName: '', userType: '', businessName: BRAND_NAME, contactPhone: BUSINESS_PHONE, urgency: 'Medium', summary: '' });
  const [transcript, setTranscript] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [rms, setRms] = useState(0);

  const sessionRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const smoothedRmsRef = useRef(0);

  // Resample Float32Array to target sample rate (linear interpolation)
  const resampleFloat32 = (input: Float32Array, inRate: number, outRate: number) => {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate;
    const newLength = Math.round(input.length / ratio);
    const out = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const idx = i * ratio;
      const idx0 = Math.floor(idx);
      const idx1 = Math.min(idx0 + 1, input.length - 1);
      const frac = idx - idx0;
      out[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
    }
    return out;
  };

  const int16FromFloat32 = (float32) => {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  };

  const base64FromInt16 = (int16) => {
    const u8 = new Uint8Array(int16.buffer);
    let CHUNK = 0x8000;
    let idx = 0;
    let binary = '';
    while (idx < u8.length) {
      const slice = u8.subarray(idx, Math.min(idx + CHUNK, u8.length));
      binary += String.fromCharCode.apply(null, slice as any);
      idx += CHUNK;
    }
    return btoa(binary);
  };

  // Play audio from the queue
  const playNextAudio = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;

    isPlayingRef.current = true;
    const audioData = audioQueueRef.current.shift();

    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }

      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') await ctx.resume();

      const binaryString = atob(audioData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16Data = new Int16Array(bytes.buffer);
      const floatData = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) {
        floatData[i] = int16Data[i] / 32768;
      }

      const audioBuffer = ctx.createBuffer(1, floatData.length, 24000);
      audioBuffer.copyToChannel(floatData, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        isPlayingRef.current = false;
        playNextAudio();
      };
      source.start();
    } catch (e) {
      console.error('Audio playback error:', e);
      isPlayingRef.current = false;
      playNextAudio();
    }
  };

  const addToTranscript = (role, text) => {
    setTranscript(prev => [...prev, { role, text, time: new Date().toLocaleTimeString() }]);
  };

  const start = async () => {
    try {
      // Force cleanup of any existing "ghost" sessions
      if (sessionRef.current) {
        try { sessionRef.current.close(); } catch (e) { }
        sessionRef.current = null;
      }

      setStatus('CONNECTING');
      setError('');
      setTranscript([]);
      setSubmitted(false);
      console.log('Starting voice assistant...');

      const apiKey = window.process?.env?.API_KEY;
      if (!apiKey) {
        throw new Error('API key not found');
      }

      audioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const ai = new GoogleGenAI({ apiKey });

      const session = await ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            console.log('CONNECTED!');
            setStatus('CONNECTED');

            // 5 SECOND COLD HANDSHAKE (Bypasses 429 congestion)
            setTimeout(() => {
              try {
                if (status !== 'CONNECTED') return;
                const inputContext = new AudioContext({ sampleRate: 16000 });
                const source = inputContext.createMediaStreamSource(stream);
                const processor = inputContext.createScriptProcessor(4096, 1, 1);

                processor.onaudioprocess = (e) => {
                  if (sessionRef.current && sessionRef.current.readyState === 1) {
                    const inputData = e.inputBuffer.getChannelData(0);
                    let sum = 0;
                    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                    const rms = Math.sqrt(sum / inputData.length);

                    // High threshold to protect quota
                        // smooth the RMS to avoid rapid toggling
                        const smoothed = smoothedRmsRef.current * 0.8 + rms * 0.2;
                        smoothedRmsRef.current = smoothed;
                        try { setRms(smoothed); } catch (e) { }

                        // lower threshold but use smoothed value
                        if (smoothed > 0.015) {
                          setIsSpeaking(true);
                          try {
                            const inRate = inputContext.sampleRate || 48000;
                            // Resample to 16000
                            const resampled = resampleFloat32(inputData, inRate, 16000);
                            const int16 = int16FromFloat32(resampled);
                            const b64 = base64FromInt16(int16);
                            session.sendRealtimeInput({
                              audio: { data: b64, mimeType: 'audio/pcm;rate=16000' }
                            });
                          } catch (err) {
                            console.error('Audio send error:', err);
                          }
                        } else {
                          setIsSpeaking(false);
                        }
                  }
                };

                source.connect(processor);
                processor.connect(inputContext.destination);
              } catch (err) {
                console.error('Handshake failed:', err);
              }
            }, 5000);
          },
          onmessage: (message) => {
            console.log('Message:', message);

            // Handle tool calls
            if (message.toolCall) {
              message.toolCall.functionCalls?.forEach(fc => {
                if (fc.name === 'sync_triage_form') {
                  console.log('Form update:', fc.args);
                  setFormData(prev => ({ ...prev, ...fc.args }));
                }
              });
            }

            // Handle text transcription from model
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  // Filter out internal AI reasoning/notes
                  const text = part.text;
                  const isInternalNote = text.startsWith('**') ||
                    text.includes("I've successfully") ||
                    text.includes("I'm currently") ||
                    text.includes("My next step") ||
                    text.includes("I am in the process");
                  if (!isInternalNote) {
                    addToTranscript('assistant', text);
                  }
                }
                if (part.inlineData?.data) {
                  audioQueueRef.current.push(part.inlineData.data);
                  playNextAudio();
                }
              }
            }

            // Handle user transcription (if available)
            if (message.serverContent?.inputTranscription) {
              addToTranscript('user', message.serverContent.inputTranscription);
            }
          },
          onerror: (e) => {
            console.error('CRITICAL API ERROR:', e);
            const errMsg = e?.message || (typeof e === 'string' ? e : 'Unknown WebSocket Error');
            setError(`Connection Failed: ${errMsg}`);
          },
          onclose: (e) => {
            console.log('Connection Closed Detail:', e);
            const reason = e?.reason || '';
            const code = e?.code || '';

            // Check for common permission vs quota codes
            if (code === 1006) {
              setError("Network Error: Connection lost immediately. Check if your API Key has 'Generative Language API' enabled in Google Cloud Console.");
            } else if (reason.includes('quota') || reason.includes('429')) {
              setError(`Quota Exceeded (429): The free tier is busy in your region. Wait 60s or check Google Cloud Console Billing.`);
              setTimeout(() => setError(''), 60000);
            } else if (reason.includes('permission') || reason.includes('403')) {
              setError(`Permission Denied (403): Your key might be restricted. Try setting "API restrictions" to "None" in Cloud Console.`);
            } else if (!reason || reason === 'Connection ended' || reason.includes('Operation is not implemented')) {
              console.log('Normal closure');
            } else {
              setError(`Status ${code || 'Error'}: ${reason || 'Disconnected'}`);
            }
            setStatus('IDLE');
            setIsSpeaking(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO, Modality.TEXT], // Request audio + text so we get transcripts
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          tools: [],
          generationConfig: {
            temperature: 0.1,
            topP: 0.5,
            topK: 1
          }
        }
      });

      sessionRef.current = session;
      console.log('Session established');
    } catch (e) {
      console.error('Error:', e);
      setError(e.message || 'Unknown error');
      setStatus('IDLE');
    }
  };

  const stop = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    audioQueueRef.current = [];
    setStatus('IDLE');
    setIsSpeaking(false);
  };

  const handleSubmit = async () => {
    const ticket = {
      submittedAt: new Date().toISOString(),
      clientName: formData.clientName || 'N/A',
      userType: formData.userType || 'N/A',
      businessName: formData.businessName || BRAND_NAME,
      contactPhone: formData.contactPhone || BUSINESS_PHONE,
      urgency: formData.urgency,
      summary: formData.summary || 'N/A',
      transcript,
    };
    console.log('Creating support ticket:', ticket);
    try {
      await navigator.clipboard.writeText(JSON.stringify(ticket, null, 2));
      alert('Support ticket created and copied to clipboard. Paste into your ticketing system or email.');
    } catch (e) {
      alert('Support ticket created. (Clipboard unavailable)\n\n' + JSON.stringify(ticket, null, 2));
    }
    setSubmitted(true);
  };

  return (
    <div className="min-h-screen p-4 md:p-8 flex items-center justify-center relative overflow-hidden">
      {/* Background Glow */}
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_50%,#0ea5e915,transparent_70%)] pointer-events-none" />

      <div className="w-full max-w-5xl z-10">
        <header className="text-center mb-10">
          <h1 className="text-4xl md:text-6xl font-black mb-2 flex items-center justify-center gap-3 italic">
            West LA <span className="text-sky-500 not-italic">Concierge</span>
          </h1>
          <p className="text-gray-400 font-medium tracking-widest uppercase text-sm">
            {OWNER_NAME} • {BUSINESS_PHONE}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-tighter ${status === 'CONNECTED' ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
              status === 'CONNECTING' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse' :
                'bg-white/5 text-gray-500 border border-white/10'
              }`}>
              {status}
            </span>
            {status === 'CONNECTED' && (
              <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-tighter transition-all duration-300 ${isSpeaking ? 'bg-sky-500 text-white animate-pulse' : 'bg-white/5 text-gray-500 opacity-50'}`}>
                {isSpeaking ? 'Audio Transmitting' : 'Silence (VAD Active)'}
              </span>
            )}
          </div>
        </header>

        {error && (
          <div className="mb-8 glass border-red-500/30 bg-red-500/10 p-4 rounded-2xl flex items-start gap-4 animate-in fade-in slide-in-from-top-4 duration-500 text-left">
            <div className="bg-red-500 text-white p-2 rounded-lg text-xs leading-none mt-1">
              <i className="fas fa-exclamation-triangle" />
            </div>
            <div className="flex-1">
              <p className="text-red-200 text-sm font-medium leading-relaxed">
                {error}
              </p>
              {error.includes('Quota') && (
                <button
                  onClick={() => start()}
                  className="mt-2 text-xs font-bold text-red-400 hover:text-red-300 underline underline-offset-4 decoration-red-500/50"
                >
                  Click here to try reconnecting now
                </button>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Controls */}
          <div className="lg:col-span-8 space-y-6">
            <div className="glass rounded-[2rem] p-12 flex flex-col items-center justify-center text-center relative overflow-hidden group">
              <div className="absolute inset-0 bg-sky-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />

              <button
                onClick={status === 'CONNECTED' ? stop : start}
                disabled={status === 'CONNECTING'}
                className={`relative w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 ${status === 'CONNECTED'
                  ? (isSpeaking ? 'bg-sky-500 mic-active scale-110 shadow-[0_0_60px_rgba(14,165,233,0.5)]' : 'bg-sky-900/50 border-2 border-sky-500/30')
                  : 'bg-white/5 hover:bg-white/10 border border-white/10 shadow-2xl'
                  }`}
              >
                <i className={`fas fa-microphone text-3xl transition-transform ${isSpeaking ? 'scale-110 text-white' : (status === 'CONNECTED' ? 'text-sky-400' : 'text-gray-600')}`} />
              </button>

              <div className="mt-8 space-y-2 text-center">
                <h3 className="text-xl font-bold tracking-tight">
                  {status === 'CONNECTED' ? (isSpeaking ? 'Assistant is listening...' : 'Waiting for voice...') :
                    status === 'CONNECTING' ? 'Establishing secure link...' :
                      'Ready to start?'}
                </h3>
                <p className="text-gray-500 text-sm font-medium">
                  {status === 'CONNECTED' ? (isSpeaking ? 'Sending audio to Gemini...' : 'VAD is saving your API quota by ignoring silence') :
                    status === 'CONNECTING' ? 'Connecting to Daniel\'s AI Infrastructure...' :
                      'Click the microphone to begin your triage call'}
                </p>
                {status === 'CONNECTED' && (
                  <p className="text-xs text-gray-400 mt-2">Mic level: {rms.toFixed(3)} — speak clearly or allow mic permissions if this stays near 0</p>
                )}
              </div>
            </div>

            {/* Transcript Area */}
            <div className="glass rounded-3xl p-6 h-[400px] flex flex-col text-left">
              <div className="flex items-center justify-between mb-4 px-2">
                <h3 className="text-xs font-black uppercase tracking-widest text-sky-500 flex items-center gap-2">
                  <i className="fas fa-comment-dots text-[10px]" />
                  Live Transcript
                </h3>
                <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-sky-500 animate-pulse' : 'bg-gray-700'}`} />
              </div>
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                {transcript.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-30 select-none">
                    <i className="fas fa-terminal text-4xl mb-4" />
                    <p className="text-xs font-bold uppercase tracking-tighter">System awaiting input...</p>
                  </div>
                ) : (
                  transcript.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                    >
                      <div className="flex items-center gap-2 mb-1 px-2">
                        <span className="text-[10px] font-black uppercase tracking-widest opacity-40">
                          {msg.role === 'user' ? 'You' : 'Concierge'}
                        </span>
                        <span className="text-[9px] opacity-20 font-medium italic">{msg.time}</span>
                      </div>
                      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user'
                        ? 'bg-sky-500/10 text-sky-100 border border-sky-500/20 rounded-tr-none'
                        : 'bg-white/5 text-gray-200 border border-white/10 rounded-tl-none font-medium'
                        }`}>
                        {msg.text}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sidebar - Client Info Form */}
          <div className="lg:col-span-4 bg-[#0d1117]/50 rounded-[2rem] border border-white/5 p-8 flex flex-col h-full overflow-hidden shadow-2xl text-left">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-gray-500 mb-8 flex items-center gap-2">
              <i className="fas fa-clipboard-list" />
              Triage Intake
            </h3>

            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-gray-600">Client Name</label>
                <input
                  type="text"
                  value={formData.clientName}
                  onChange={(e) => setFormData(prev => ({ ...prev, clientName: e.target.value }))}
                  className="w-full bg-white/5 border border-white/5 focus:border-sky-500/50 focus:bg-white/10 rounded-xl px-4 py-3 text-sm transition-all outline-none"
                  placeholder="Awaiting name..."
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-gray-600">User Type</label>
                <select
                  value={formData.userType}
                  onChange={(e) => setFormData(prev => ({ ...prev, userType: e.target.value }))}
                  className="w-full bg-white/5 border border-white/5 focus:border-sky-500/50 focus:bg-white/10 rounded-xl px-4 py-3 text-sm transition-all outline-none appearance-none"
                >
                  <option value="">Select Category...</option>
                  <option value="Business">Business Professional</option>
                  <option value="Personal">Personal/Home User</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-gray-600">Business Name</label>
                <input
                  type="text"
                  value={formData.businessName}
                  onChange={(e) => setFormData(prev => ({ ...prev, businessName: e.target.value }))}
                  className="w-full bg-white/5 border border-white/5 focus:border-sky-500/50 focus:bg-white/10 rounded-xl px-4 py-3 text-sm transition-all outline-none"
                  placeholder="If applicable..."
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-gray-600">Contact Phone</label>
                <input
                  type="text"
                  value={formData.contactPhone || BUSINESS_PHONE}
                  readOnly
                  className="w-full bg-white/5 border border-white/5 rounded-xl px-4 py-3 text-sm transition-all outline-none opacity-80"
                  placeholder="Business phone"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-gray-600">Priority Level</label>
                <div className="grid grid-cols-2 gap-2">
                  {['Low', 'Medium', 'High', 'Critical'].map((level) => (
                    <button
                      key={level}
                      onClick={() => setFormData(prev => ({ ...prev, urgency: level }))}
                      className={`py-2 px-1 rounded-lg text-[10px] font-black uppercase tracking-tighter border transition-all ${formData.urgency === level
                        ? 'bg-sky-500 border-sky-400 text-white shadow-lg'
                        : 'bg-white/5 border-white/5 text-gray-500 hover:bg-white/10'
                        }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-gray-600">Issue Summary</label>
                <textarea
                  value={formData.summary}
                  onChange={(e) => setFormData(prev => ({ ...prev, summary: e.target.value }))}
                  className="w-full bg-white/5 border border-white/5 focus:border-sky-500/50 focus:bg-white/10 rounded-xl px-4 py-3 text-sm transition-all outline-none h-24 resize-none"
                  placeholder="Key problem details..."
                />
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitted || !formData.clientName}
              className={`mt-8 w-full py-4 rounded-2xl font-black uppercase tracking-widest text-xs transition-all ${submitted
                ? 'bg-green-500/20 text-green-400 cursor-not-allowed border border-green-500/30'
                : 'bg-gradient-to-r from-sky-600 to-sky-500 hover:from-sky-500 hover:to-sky-400 text-white shadow-[0_10px_30px_rgba(14,165,233,0.3)] hover:shadow-[0_15px_40px_rgba(14,165,233,0.4)] active:scale-95'
                }`}
            >
              {submitted ? '✓ Submission Confirmed' : 'Finish & Submit Inquiry'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);