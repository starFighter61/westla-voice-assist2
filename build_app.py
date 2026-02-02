import os
import shutil

# ==============================================================================
# WEST LA COMPUTER EXPERT - INFRASTRUCTURE CONCIERGE STABILIZER (REPAIR TOOL)
# ==============================================================================

FILES = {
    "index.html": """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>West LA Computer Expert | Infrastructure AI</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" />
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script>
    window.process = { env: { API_KEY: "AIzaSyC0zuGh-YYvHbX2a1QdDIv14GFIjYBooRU" } };
  </script>
  <style>
    body { font-family: 'Inter', sans-serif; background-color: #010409; color: #f0f6fc; margin: 0; overflow-x: hidden; }
    .glass { background: rgba(13, 17, 23, 0.85); backdrop-filter: blur(24px); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
    @keyframes pulse-ring {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.7); }
      70% { transform: scale(1.05); box-shadow: 0 0 0 20px rgba(14, 165, 233, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); }
    }
    .mic-active { animation: pulse-ring 2s infinite; }
    .log-entry { transition: all 0.3s ease; opacity: 0.7; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .log-entry:first-child { opacity: 1; transform: scale(1.02); color: #38bdf8; }
  </style>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.2.0",
      "react-dom": "https://esm.sh/react-dom@18.2.0",
      "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
      "@google/genai": "https://esm.sh/@google/genai@0.2.1"
    }
  }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-presets="typescript,react" data-type="module" src="./index.tsx"></script>
</body>
</html>""",

    "index.tsx": """import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Modality, Type } from '@google/genai';

const BRAND_NAME = "West LA Computer Expert";
const BUSINESS_PHONE = "310-850-8093";
const WEBSITE = "westlacomputerexpert.com";

const SYSTEM_INSTRUCTION = `You are the "Infrastructure Concierge" for West LA Computer Expert (Daniel Zivetz). IDENTITY: Daniel Zivetz is technical lead. Phone: ${BUSINESS_PHONE}. TONE: Professional. GREETING: "Infrastructure Concierge active. How can I assist?"`;

const TRIAGE_TOOL = {
  name: 'sync_triage_form',
  description: 'Updates triage details.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      clientName: { type: Type.STRING },
      businessName: { type: Type.STRING },
      urgency: { type: Type.STRING, enum: ['Low', 'Medium', 'High', 'Critical'] },
      summary: { type: Type.STRING }
    }
  }
};

const encode = (b) => btoa(Array.from(b).map(c => String.fromCharCode(c)).join(''));
const decode = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const App = () => {
  const [status, setStatus] = useState('IDLE');
  const [formData, setFormData] = useState({ clientName: '', businessName: '', urgency: 'Medium', summary: '' });
  const sessionRef = useRef(null);

  const start = async () => {
    try {
      setStatus('CONNECTING');
      const apiKey = window.process.env.API_KEY;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => setStatus('CONNECTED'),
          onmessage: (m) => {
            if (m.toolCall) {
              m.toolCall.functionCalls.forEach(fc => {
                if (fc.name === 'sync_triage_form') setFormData(prev => ({ ...prev, ...fc.args }));
              });
            }
          },
          onclose: () => setStatus('IDLE')
        },
        config: { responseModalities: [Modality.AUDIO], systemInstruction: SYSTEM_INSTRUCTION, tools: [{ functionDeclarations: [TRIAGE_TOOL] }] }
      });
      sessionRef.current = await sessionPromise;
    } catch (e) { setStatus('IDLE'); }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#010409] text-white p-6">
      <div className="glass max-w-4xl w-full rounded-[4rem] p-16 text-center">
        <h1 className="text-5xl font-black mb-8 italic">West LA <span className="text-sky-500">Concierge</span></h1>
        <button onClick={() => status === 'CONNECTED' ? sessionRef.current.close() : start()} className={`w-40 h-40 rounded-full border-8 transition-all ${status === 'CONNECTED' ? 'bg-sky-500 border-sky-400' : 'bg-slate-900 border-white/5'}`}>
          <i className="fa-solid fa-microphone text-4xl"></i>
        </button>
        <div className="grid grid-cols-2 gap-4 mt-12 text-left">
          <div className="bg-white/5 p-6 rounded-3xl"><b>{formData.clientName || '---'}</b></div>
          <div className="bg-white/5 p-6 rounded-3xl"><b className="text-sky-400">{formData.urgency}</b></div>
          <div className="col-span-2 bg-white/5 p-6 rounded-3xl italic">{formData.summary || 'Awaiting signal...'}</div>
        </div>
      </div>
    </div>
  );
};
ReactDOM.createRoot(document.getElementById('root')).render(<App />);""",

    "metadata.json": """{ "requestFramePermissions": ["microphone"], "name": "West LA Computer Expert Concierge" }"""
}

TRASH_PATTERNS = ["({", "{", "types.ts", "constants.ts", "setup.py", "server.py", "project_setup.py", "setup_and_run.py", "App.tsx", "netlify.toml", ".gitignore", "README.md", "setError('Connection", "setStatus('CONNECTED')", "setStatus('DISCONNECTED')"]
TRASH_DIRS = ["components", "src"]

def clean():
    for item in TRASH_PATTERNS:
        if os.path.exists(item):
            try: os.remove(item)
            except: pass
    for folder in TRASH_DIRS:
        if os.path.exists(folder):
            try: shutil.rmtree(folder)
            except: pass

def build():
    clean()
    for name, content in FILES.items():
        with open(name, "w", encoding="utf-8") as f: f.write(content)
    print("REPAIR COMPLETE. Run: python -m http.server 8000")

if __name__ == "__main__": build()
