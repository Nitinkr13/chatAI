
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { TrainingSessionConfig, TranscriptionItem } from '../types';
import { encode, decode, decodeAudioData } from '../utils/audio';

interface LiveConversationProps {
  config: TrainingSessionConfig;
  onEnd: (history: TranscriptionItem[]) => void;
}

const LiveConversation: React.FC<LiveConversationProps> = ({ config, onEnd }) => {
  const [isActive, setIsActive] = useState(false);
  const [transcription, setTranscription] = useState<TranscriptionItem[]>([]);
  const [activeUserText, setActiveUserText] = useState('');
  const [activeModelText, setActiveModelText] = useState('');
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const transcriptionRef = useRef<TranscriptionItem[]>([]);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const lastCommittedInputRef = useRef('');
  const lastCommittedOutputRef = useRef('');
  const sessionTokenRef = useRef(0);

  const mergeTranscript = useCallback((current: string, incoming: string) => {
    if (!incoming) return current;
    if (incoming.startsWith(current)) return incoming;
    if (current.startsWith(incoming)) return current;
    return current + incoming;
  }, []);

  const initializeAudio = async () => {
    audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
  };

  const stopSession = useCallback(() => {
    sessionTokenRef.current += 1;
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setIsActive(false);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcription, activeUserText, activeModelText]);

  const startSession = async () => {
    const token = sessionTokenRef.current + 1;
    sessionTokenRef.current = token;

    await initializeAudio();
    if (token !== sessionTokenRef.current) {
      return;
    }

    setIsActive(true);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // STRONGER CHARACTER ENFORCEMENT
    const systemInstruction = `
      CRITICAL: You are NOT an AI assistant. You are strictly inhabiting the character: ${config.role}.
      STAY IN CHARACTER AT ALL TIMES. Use the persona's vocabulary, attitude, and tone.
      
      Your goal is to interact with the user based on this document context:
      ---
      ${config.contextText}
      ---
      
      Rules:
      1. Stay strictly as ${config.role}. 
      2. Ask exactly one question or give one response at a time.
      3. Listen to the user's answer and react exactly as ${config.role} would.
      4. If the user asks for feedback, only give it if it fits the character.
      5. Do not explain that you are an AI. Do not be overly polite if the character isn't.
    `;

    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      callbacks: {
        onopen: () => {
          const source = audioContextInRef.current!.createMediaStreamSource(streamRef.current!);
          const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
          
          scriptProcessor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const l = inputData.length;
            const int16 = new Int16Array(l);
            for (let i = 0; i < l; i++) {
              int16[i] = inputData[i] * 32768;
            }
            const pcmBlob = {
              data: encode(new Uint8Array(int16.buffer)),
              mimeType: 'audio/pcm;rate=16000',
            };
            
            sessionPromise.then(session => {
              if (session) session.sendRealtimeInput({ media: pcmBlob });
            });
          };

          source.connect(scriptProcessor);
          scriptProcessor.connect(audioContextInRef.current!.destination);
        },
        onmessage: async (message: LiveServerMessage) => {
          // Handle Input Transcription (User)
          if (message.serverContent?.inputTranscription) {
            currentInputText.current = mergeTranscript(
              currentInputText.current,
              message.serverContent.inputTranscription.text
            );
            setActiveUserText(currentInputText.current);
          }
          
          // Handle Output Transcription (Model)
          if (message.serverContent?.outputTranscription) {
            currentOutputText.current = mergeTranscript(
              currentOutputText.current,
              message.serverContent.outputTranscription.text
            );
            setActiveModelText(currentOutputText.current);
          }

          // Commit transcription only on turnComplete to prevent duplicates
          if (message.serverContent?.turnComplete) {
            const userFinal = currentInputText.current.trim();
            const modelFinal = currentOutputText.current.trim();

            const isDuplicateTurn =
              userFinal === lastCommittedInputRef.current &&
              modelFinal === lastCommittedOutputRef.current;

            if (!isDuplicateTurn) {
              lastCommittedInputRef.current = userFinal;
              lastCommittedOutputRef.current = modelFinal;
            }
            
            const commits: TranscriptionItem[] = [];
            if (!isDuplicateTurn) {
              if (userFinal) commits.push({ speaker: 'user', text: userFinal, timestamp: Date.now() });
              if (modelFinal) commits.push({ speaker: 'model', text: modelFinal, timestamp: Date.now() });
            }
            
            if (commits.length > 0) {
              setTranscription(prev => [...prev, ...commits]);
              transcriptionRef.current.push(...commits);
            }
            
            currentInputText.current = '';
            currentOutputText.current = '';
            setActiveUserText('');
            setActiveModelText('');
            setIsModelSpeaking(false);
          }

          // Handle Audio Output
          const parts = message.serverContent?.modelTurn?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.inlineData?.data) {
                setIsModelSpeaking(true);
                const outCtx = audioContextOutRef.current!;
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
                
                const buffer = await decodeAudioData(decode(part.inlineData.data), outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = buffer;
                source.connect(outCtx.destination);
                
                source.addEventListener('ended', () => {
                  sourcesRef.current.delete(source);
                });
                
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
                sourcesRef.current.add(source);
              }
            }
          }

          if (message.serverContent?.interrupted) {
            sourcesRef.current.forEach(s => s.stop());
            sourcesRef.current.clear();
            nextStartTimeRef.current = 0;
            currentOutputText.current = '';
            setActiveModelText('');
            setIsModelSpeaking(false);
          }
        },
        onerror: (e) => console.error('Live API Error:', e),
        onclose: () => setIsActive(false),
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });

    const session = await sessionPromise;
    if (token !== sessionTokenRef.current) {
      session?.close();
      return;
    }
    sessionRef.current = session;
  };

  useEffect(() => {
    startSession();
    return () => stopSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-[650px] w-full max-w-4xl mx-auto bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-100">
      <div className="bg-slate-900 px-6 py-5 flex items-center justify-between text-white border-b border-slate-800">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-10 h-10 bg-indigo-500 rounded-full flex items-center justify-center text-white font-bold text-lg">
              {config.role.charAt(0).toUpperCase()}
            </div>
            <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 border-2 border-slate-900 rounded-full"></div>
          </div>
          <div>
            <h3 className="font-bold text-lg leading-tight">{config.role}</h3>
            <p className="text-xs text-slate-400 font-medium tracking-wide uppercase">Active Session</p>
          </div>
        </div>
        <button 
          onClick={() => onEnd(transcriptionRef.current)}
          className="bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-all border border-red-500/20"
        >
          End Session
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50 scroll-smooth">
        {transcription.length === 0 && !activeUserText && !activeModelText && (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <div className="audio-wave mb-6">
              {[...Array(8)].map((_, i) => <div key={i} className="wave-bar" style={{ animationDelay: `${i * 0.1}s` }}></div>)}
            </div>
            <p className="text-lg font-bold text-slate-500">The character is preparing to speak...</p>
          </div>
        )}
        
        {transcription.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-3xl px-6 py-4 shadow-sm ${
              msg.speaker === 'user' 
                ? 'bg-indigo-600 text-white rounded-tr-none' 
                : 'bg-white text-slate-800 rounded-tl-none border border-slate-200'
            }`}>
              <p className="text-sm font-medium leading-relaxed">{msg.text}</p>
              <div className={`text-[10px] mt-2 opacity-60 ${msg.speaker === 'user' ? 'text-right' : 'text-left'}`}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}

        {activeUserText && (
          <div className="flex justify-end animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="max-w-[75%] rounded-3xl px-6 py-4 bg-indigo-500/60 text-white rounded-tr-none italic">
              <p className="text-sm font-medium">{activeUserText}...</p>
            </div>
          </div>
        )}

        {activeModelText && (
          <div className="flex justify-start animate-in fade-in slide-in-from-left-4 duration-300">
            <div className="max-w-[75%] rounded-3xl px-6 py-4 bg-white/80 text-slate-800 rounded-tl-none border border-indigo-200 border-dashed italic">
              <p className="text-sm font-medium">{activeModelText}...</p>
            </div>
          </div>
        )}
      </div>

      <div className="p-8 bg-white border-t border-slate-100 flex items-center justify-center gap-12">
        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-inner ${isActive ? 'bg-indigo-600 text-white scale-110' : 'bg-slate-100 text-slate-400'}`}>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Listening</span>
        </div>
        
        <div className="h-16 w-px bg-slate-100" />

        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-inner ${isModelSpeaking ? 'bg-green-500 text-white scale-110 shadow-lg shadow-green-100' : 'bg-slate-100 text-slate-400'}`}>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
            {isModelSpeaking ? "Speaking" : "Waiting"}
          </span>
        </div>
      </div>
    </div>
  );
};

export default LiveConversation;
