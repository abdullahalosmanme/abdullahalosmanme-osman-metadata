
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AppState, ImageData, PhotoMetadata, ApiProvider, AppConfig, ModelOption } from './types';
import { Logo } from './components/Logo';
import { fileToBase64, downloadCSV } from './utils/fileUtils';
import { generatePhotoMetadata } from './services/geminiService';
import { generatePhotoMetadataWithGroq } from './services/groqService';

const AVAILABLE_MODELS: ModelOption[] = [
  // Gemini Models
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', provider: 'gemini', tier: 'low', description: 'Fast, cost-effective for large batches' },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', provider: 'gemini', tier: 'high', description: 'High precision, better quality for complex images' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'gemini', tier: 'low', description: 'Standard fast model' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini', tier: 'high', description: 'Standard high-reasoning model' },

  // Groq Models
  { id: 'llama-3.2-11b-vision-preview', name: 'LLaMA 3.2 11B Vision', provider: 'groq', tier: 'low', description: 'Ultra-fast open source vision model' },
  { id: 'llama-3.2-90b-vision-preview', name: 'LLaMA 3.2 90B Vision', provider: 'groq', tier: 'high', description: 'Advanced open source vision intelligence' }
];

const CONCURRENCY_LIMIT = 2; // Safer limit for free tier
const INITIAL_BACKOFF = 3000; // 3 seconds base for 429s

const DEFAULT_CONFIG: AppConfig = {
  provider: 'gemini',
  model: 'gemini-3-flash-preview',
  keys: {
    gemini: '',
    groq: '',
    openai: ''
  }
};

export default function App() {
  const [appState, setAppState] = useState<AppState>(AppState.SPLASH);
  const [images, setImages] = useState<ImageData[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const [config, setConfig] = useState<AppConfig>(() => {
    const saved = localStorage.getItem('osman_v1_config');
    return saved ? JSON.parse(saved) : DEFAULT_CONFIG;
  });

  const stopRequested = useRef(false);
  const pauseRef = useRef(false);
  const processingQueue = useRef<string[]>([]);
  const retryQueue = useRef<string[]>([]);
  const globalBackoffUntil = useRef<number>(0);

  useEffect(() => {
    localStorage.setItem('osman_v1_config', JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAppState(AppState.HOME);
    }, 2800);
    return () => clearTimeout(timer);
  }, []);

  const hasConfigured = useMemo(() => {
    const key = config.keys[config.provider];
    return key && key.trim().length > 0;
  }, [config]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const selectedFiles = Array.from(e.target.files) as File[];

    if (images.length + selectedFiles.length > 500) {
      alert("Maximum 500 images allowed per batch.");
      return;
    }

    const newImages: ImageData[] = selectedFiles.map((file, index) => ({
      id: `${Date.now()}-${index}`,
      file,
      preview: URL.createObjectURL(file),
      status: 'pending',
      retryCount: 0
    }));
    setImages(prev => [...prev, ...newImages]);
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const processSingleImage = async (imgId: string) => {
    if (stopRequested.current) return;

    // Pause or Global Backoff Logic
    while (pauseRef.current || Date.now() < globalBackoffUntil.current) {
      if (Date.now() < globalBackoffUntil.current) {
        setImages((prev: ImageData[]) => prev.map((item: ImageData) => item.id === imgId ? { ...item, error: `Waiting for quota...` } : item));
      }
      await sleep(1000);
      if (stopRequested.current) return;
    }

    setImages((prev: ImageData[]) => prev.map((item: ImageData) => item.id === imgId ? { ...item, status: 'processing', error: undefined } : item));

    const img = images.find((i: ImageData) => i.id === imgId);
    if (!img) return;

    try {
      const { base64, mimeType } = await fileToBase64(img.file);

      let result;
      const apiKey = config.keys[config.provider];

      if (!apiKey) throw new Error("API Key is missing. Please configure it in settings.");

      if (config.provider === 'gemini') {
        result = await generatePhotoMetadata(base64, mimeType, config.model, apiKey);
      } else if (config.provider === 'groq') {
        result = await generatePhotoMetadataWithGroq(base64, config.model, apiKey);
      } else {
        throw new Error("Provider not currently supported for vision tasks");
      }

      const metadata: PhotoMetadata = {
        title: result.title,
        keywords: result.keywords.join(', ')
      };

      setImages((prev: ImageData[]) => prev.map((item: ImageData) => item.id === imgId ? {
        ...item,
        status: 'completed',
        metadata,
        error: undefined
      } : item));
    } catch (err: any) {
      const isQuotaError = err.message?.includes('429') || err.status === 429 || JSON.stringify(err).includes('429');

      if (isQuotaError) {
        // Trigger global backoff to stop all workers
        const waitTime = INITIAL_BACKOFF * Math.pow(2, img.retryCount || 0);
        globalBackoffUntil.current = Date.now() + waitTime;

        setImages((prev: ImageData[]) => prev.map((item: ImageData) => item.id === imgId ? {
          ...item,
          status: 'pending',
          retryCount: (item.retryCount || 0) + 1,
          error: `Quota exceeded. Retrying in ${Math.round(waitTime / 1000)}s...`
        } : item));

        retryQueue.current.push(imgId);
      } else {
        setImages((prev: ImageData[]) => prev.map((item: ImageData) => item.id === imgId ? {
          ...item,
          status: 'failed',
          error: "Analysis error. Technical failure."
        } : item));
      }
    }
  };

  const startProcessing = async () => {
    if (images.length === 0) return;
    setAppState(AppState.PROCESSING);
    setIsProcessing(true);
    setIsPaused(false);
    pauseRef.current = false;
    stopRequested.current = false;
    globalBackoffUntil.current = 0;

    processingQueue.current = images.filter((img: ImageData) => img.status === 'pending').map((img: ImageData) => img.id);
    retryQueue.current = [];

    const runWorker = async () => {
      while (!stopRequested.current) {
        let nextId = processingQueue.current.shift();

        if (!nextId && retryQueue.current.length > 0) {
          await sleep(2000); // Wait before grabbing from retry
          nextId = retryQueue.current.shift();
        }

        if (!nextId) break;
        await processSingleImage(nextId);
        await sleep(500); // Short throttle between requests
      }
    };

    const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => runWorker());
    await Promise.all(workers);

    setIsProcessing(false);
    if (!stopRequested.current) {
      setAppState(AppState.RESULTS);
    }
  };

  const togglePause = () => {
    setIsPaused(!isPaused);
    pauseRef.current = !isPaused;
  };

  const terminateProcess = () => {
    stopRequested.current = true;
    setIsProcessing(false);
    setAppState(AppState.RESULTS);
  };

  const clearAndReset = () => {
    setImages([]);
    setSearchTerm('');
    setAppState(AppState.HOME);
  };

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(type);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const progressPercent = useMemo(() => {
    const total = images.length;
    if (total === 0) return 0;
    const finished = images.filter((img: ImageData) => img.status === 'completed' || img.status === 'failed').length;
    return Math.round((finished / total) * 100);
  }, [images]);

  const filteredImages = useMemo(() => {
    return images.filter((img: ImageData) =>
      img.file.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [images, searchTerm]);

  if (appState === AppState.SPLASH) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-[#0a0a0a]">
        <Logo size="lg" />
        <h1 className="mt-8 text-5xl font-title font-bold tracking-[0.2em] text-white">OSMAN <span className="text-[#e94560]">METADATA</span></h1>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col font-sans text-white overflow-x-hidden">
      {/* Header */}
      <header className="px-8 py-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-[#0a0a0a]/90 backdrop-blur-xl z-50 shadow-2xl">
        <div className="flex items-center gap-5 cursor-pointer" onClick={() => setAppState(AppState.HOME)}>
          <Logo size="sm" />
          <div>
            <h1 className="text-xl font-title font-bold tracking-tight">OSMAN METADATA</h1>
            <p className="text-white/40 text-[9px] uppercase tracking-[0.2em]">Infrastructure Control Panel</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={() => setAppState(appState === AppState.SETTINGS ? AppState.HOME : AppState.SETTINGS)}
            className={`p-2.5 rounded-xl transition-all border ${appState === AppState.SETTINGS ? 'bg-[#00d2ff] text-black border-[#00d2ff]' : 'bg-white/5 border-white/10 text-white/60 hover:text-white'}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          </button>
          <div className="h-8 w-px bg-white/10 mx-2"></div>
          <div className="flex flex-col items-end">
            <span className={`text-[10px] font-bold uppercase flex items-center gap-1.5 ${hasConfigured ? 'text-green-500' : 'text-yellow-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${hasConfigured ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
              {hasConfigured ? 'Ready' : 'Incomplete'}
            </span>
            <span className="text-[9px] text-white/30 uppercase tracking-tighter">v1.1.2.STABLE</span>
          </div>
        </div>
      </header>

      <main className="flex-grow container mx-auto px-6 py-10">

        {appState === AppState.SETTINGS && (
          <div className="max-w-3xl mx-auto animate-fade-in bg-[#141414] border border-white/10 rounded-[2.5rem] p-12 shadow-2xl">
            <h2 className="text-4xl font-title font-bold mb-8 tracking-tight">System Configuration</h2>

            <div className="space-y-10">
              <section className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-white/30">AI Provider Selection</label>
                <div className="grid grid-cols-3 gap-4">
                  {(['gemini', 'groq', 'openai'] as ApiProvider[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setConfig({ ...config, provider: p, model: p === 'gemini' ? 'gemini-3-flash-preview' : config.model })}
                      className={`py-4 rounded-2xl font-bold uppercase text-xs transition-all border ${config.provider === p ? 'bg-[#00d2ff] text-black border-[#00d2ff]' : 'bg-white/5 border-white/10 text-white/40 hover:text-white'}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-white/30">Infrastructure Model Identifier (Select Tier)</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {AVAILABLE_MODELS.filter(m => m.provider === config.provider).map(model => (
                    <button
                      key={model.id}
                      onClick={() => setConfig({ ...config, model: model.id })}
                      className={`p-4 rounded-xl border text-left transition-all ${config.model === model.id ? 'bg-[#00d2ff]/10 border-[#00d2ff] scale-[1.02]' : 'bg-white/5 border-white/10 hover:border-white/30'}`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className={`font-bold text-sm ${config.model === model.id ? 'text-[#00d2ff]' : 'text-white'}`}>{model.name}</span>
                        <span className={`text-[8px] uppercase tracking-widest px-2 py-0.5 rounded font-bold ${model.tier === 'high' ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {model.tier} Tier
                        </span>
                      </div>
                      <p className="text-[10px] text-white/40 leading-relaxed font-medium">{model.description}</p>
                    </button>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-white/30">{config.provider.toUpperCase()} Private Access Key</label>
                <input
                  type="password"
                  value={config.keys[config.provider]}
                  onChange={(e) => setConfig({ ...config, keys: { ...config.keys, [config.provider]: e.target.value } })}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm focus:border-[#00d2ff] outline-none transition-all"
                  placeholder="Enter your API key..."
                />
              </section>

              <div className="pt-8 flex gap-4">
                <button onClick={() => setAppState(AppState.HOME)} className="flex-grow bg-[#00d2ff] text-black py-5 rounded-2xl font-bold shadow-xl active:scale-95 transition-all">Apply & Save</button>
                <button onClick={() => setConfig(DEFAULT_CONFIG)} className="px-10 py-5 rounded-2xl border border-white/10 text-white/30 font-bold hover:text-white transition-all">Default</button>
              </div>
            </div>
          </div>
        )}

        {appState === AppState.HOME && (
          <div className="max-w-5xl mx-auto space-y-12 animate-fade-in text-center">
            <div className="bg-[#141414] rounded-[2.5rem] p-12 lg:p-20 border border-white/5 relative overflow-hidden shadow-2xl">
              <div className="absolute top-0 right-0 w-64 h-64 bg-[#00d2ff]/5 blur-[100px] rounded-full"></div>
              <div className="mb-10 p-10 bg-black/20 rounded-full border border-white/5 inline-block shadow-inner">
                <svg className="w-20 h-20 text-[#00d2ff] animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <h2 className="text-5xl lg:text-6xl font-title font-bold mb-6 tracking-tight">AI Metadata Engine</h2>
              <p className="text-white/50 text-lg mb-12 max-w-2xl mx-auto leading-relaxed uppercase tracking-widest text-xs font-bold">Visual SEO Infrastructure for Contributors</p>

              <div className="flex flex-col items-center gap-6">
                <label className="group relative bg-[#00d2ff] hover:bg-[#57e4ff] text-black px-16 py-7 rounded-2xl font-bold text-2xl cursor-pointer transition-all shadow-xl hover:scale-105 active:scale-95">
                  Select Visuals
                  <input type="file" multiple accept="image/jpeg,image/png" className="hidden" onChange={handleFileSelect} />
                </label>
                <p className="text-[10px] text-white/20 uppercase tracking-[0.3em] font-bold">Safe Batch: 500 Files • Quota Managed</p>
              </div>

              {images.length > 0 && (
                <div className="mt-16 pt-16 border-t border-white/5 animate-fade-in">
                  <div className="bg-white/5 px-8 py-4 rounded-2xl border border-white/10 inline-block mb-10">
                    <span className="text-4xl font-bold text-[#00d2ff]">{images.length}</span>
                    <span className="text-[10px] ml-4 text-white/40 uppercase tracking-[0.2em] font-bold">Assets Prepared</span>
                  </div>
                  <div className="flex justify-center gap-4">
                    <button
                      onClick={startProcessing}
                      disabled={!hasConfigured}
                      className={`bg-white text-black font-title font-bold px-12 py-5 rounded-2xl transition-all flex items-center justify-center gap-4 shadow-2xl ${!hasConfigured ? 'opacity-30 cursor-not-allowed' : 'hover:scale-105 active:scale-95'}`}
                    >
                      Start Analysis Pipeline
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                    </button>
                    <button onClick={clearAndReset} className="px-10 py-5 rounded-2xl border border-white/10 text-white/30 font-bold hover:text-white transition-all uppercase text-xs tracking-widest">Clear</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {appState === AppState.PROCESSING && (
          <div className="max-w-6xl mx-auto flex flex-col items-center animate-fade-in">
            <div className="relative w-80 h-80 mb-16 flex items-center justify-center">
              <div className="absolute inset-0 bg-[#00d2ff]/10 blur-[120px] rounded-full animate-pulse"></div>
              <svg className="w-full h-full transform -rotate-90 relative z-10">
                <circle cx="160" cy="160" r="140" stroke="rgba(255,255,255,0.03)" strokeWidth="12" fill="transparent" />
                <circle
                  cx="160" cy="160" r="140" stroke="#00d2ff" strokeWidth="12" fill="transparent"
                  strokeDasharray={880}
                  strokeDashoffset={880 - (880 * progressPercent) / 100}
                  strokeLinecap="round"
                  className="transition-all duration-700 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
                <span className="text-8xl font-bold font-title tracking-tighter leading-none">{progressPercent}%</span>
                <span className="text-[10px] uppercase tracking-[0.5em] text-white/40 mt-4 font-bold">Network Infrastructure Active</span>
              </div>
            </div>

            <div className="flex gap-4 mb-16">
              <button onClick={togglePause} className="px-12 py-4 rounded-2xl bg-white/5 border border-white/10 text-white font-bold uppercase tracking-widest text-xs hover:bg-white/10 transition-all active:scale-95">
                {isPaused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <button onClick={terminateProcess} className="px-12 py-4 rounded-2xl bg-[#e94560]/10 border border-[#e94560]/20 text-[#e94560] font-bold uppercase tracking-widest text-xs hover:bg-[#e94560] hover:text-white transition-all active:scale-95">
                ⏹ Terminate
              </button>
            </div>

            <div className="w-full bg-[#141414] rounded-[2.5rem] p-10 border border-white/5 shadow-2xl">
              <div className="flex justify-between items-center mb-10 px-2">
                <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Infrastructure Stream</h3>
                <div className="flex gap-8 items-center font-bold text-[10px] uppercase tracking-wider">
                  <span className="text-green-500/80">SUCCESS: {images.filter((img: ImageData) => img.status === 'completed').length}</span>
                  <span className="text-[#e94560]/80">REMAINING: {images.filter((img: ImageData) => img.status === 'pending' || img.status === 'processing').length}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-h-[500px] overflow-y-auto pr-4 custom-scrollbar">
                {images.map((img: ImageData) => (
                  <div key={img.id} className={`p-5 rounded-[1.5rem] flex items-center gap-5 border transition-all duration-500 ${img.status === 'completed' ? 'bg-white/[0.03] border-green-500/20' :
                    img.status === 'processing' ? 'bg-[#00d2ff]/5 border-[#00d2ff]/30' :
                      'bg-white/[0.01] border-white/5'
                    }`}>
                    <div className="relative flex-shrink-0">
                      <img src={img.preview} alt="preview" className="w-16 h-16 object-cover rounded-xl border border-white/10" />
                      {img.status === 'processing' && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-xl">
                          <div className="w-5 h-5 border-2 border-[#00d2ff] border-t-transparent rounded-full animate-spin"></div>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col flex-grow overflow-hidden">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-bold truncate max-w-[150px] text-white/80 uppercase tracking-tighter">{img.file.name}</span>
                        <span className={`text-[8px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${img.status === 'completed' ? 'text-green-500' :
                          img.status === 'failed' ? 'text-[#e94560]' :
                            img.status === 'processing' ? 'text-[#00d2ff]' : 'text-white/20'
                          }`}>
                          {img.status}
                        </span>
                      </div>

                      <div className="h-4 flex items-center">
                        <p className={`text-[9px] uppercase tracking-widest font-bold ${img.error ? 'text-yellow-500' : 'text-white/20'}`}>
                          {img.metadata ? `"${img.metadata.title.substring(0, 30)}..."` : (img.error || (img.status === 'processing' ? 'Analyzing...' : 'Standby'))}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {appState === AppState.RESULTS && (
          <div className="max-w-7xl mx-auto animate-fade-in">
            <div className="bg-[#141414] rounded-[2.5rem] p-12 mb-12 border border-white/5 shadow-2xl flex flex-col lg:flex-row items-center justify-between gap-10">
              <div className="text-center lg:text-left">
                <h2 className="text-5xl font-title font-bold mb-3 tracking-tight">Analysis Report</h2>
                <p className="text-white/40 uppercase tracking-[0.3em] text-[10px] font-bold">
                  {images.filter((i: ImageData) => i.status === 'completed').length} ASSETS OPTIMIZED • DATA READY
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-6">
                <button
                  onClick={() => downloadCSV(images)}
                  className="bg-[#00d2ff] hover:bg-[#57e4ff] text-black px-16 py-6 rounded-2xl font-bold flex items-center gap-4 shadow-[0_10px_30px_rgba(0,210,255,0.2)] transition-all hover:-translate-y-1 active:translate-y-0"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  Export Data Pipeline (CSV)
                </button>
                <button
                  onClick={clearAndReset}
                  className="bg-white/5 hover:bg-white/10 text-white px-10 py-6 rounded-2xl font-bold transition-all border border-white/10"
                >
                  Clear System
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
              {filteredImages.map((img: ImageData) => (
                <div key={img.id} className="bg-[#141414] rounded-[2.5rem] overflow-hidden flex flex-col border border-white/10 group hover:border-[#00d2ff]/30 transition-all duration-500 shadow-xl relative">
                  <div className="relative h-72 overflow-hidden">
                    <img src={img.preview} alt="preview" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-1000" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
                    <div className="absolute bottom-6 left-6 right-6">
                      <span className="text-[10px] font-bold text-white/50 uppercase tracking-widest block mb-2">{img.file.name}</span>
                      <h4 className="text-lg font-bold text-white leading-tight font-title line-clamp-2">
                        {img.metadata?.title || "No Title Generated"}
                      </h4>
                    </div>
                  </div>

                  <div className="p-10 flex-grow flex flex-col">
                    {img.metadata ? (
                      <div className="space-y-8">
                        <div>
                          <div className="flex justify-between items-center mb-4">
                            <span className="text-[10px] uppercase tracking-widest text-[#00d2ff] font-bold">Generated SEO Title</span>
                            <button onClick={() => copyToClipboard(img.metadata!.title, 'Title')} className="text-white/30 hover:text-[#00d2ff] transition-all p-2 bg-white/5 rounded-xl">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                            </button>
                          </div>
                          <p className="text-sm font-medium text-white/90 leading-relaxed italic border-l-2 border-[#00d2ff] pl-4">{img.metadata.title}</p>
                        </div>

                        <div>
                          <div className="flex justify-between items-center mb-4">
                            <span className="text-[10px] uppercase tracking-widest text-white/30 font-bold">SEO Keywords (40)</span>
                            <button onClick={() => copyToClipboard(img.metadata!.keywords, 'Keywords')} className="text-white/30 hover:text-[#00d2ff] transition-all p-2 bg-white/5 rounded-xl">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                            </button>
                          </div>
                          <div className="h-44 overflow-y-auto bg-black/40 rounded-2xl p-6 border border-white/5 custom-scrollbar">
                            <div className="flex flex-wrap gap-2">
                              {img.metadata.keywords.split(',').map((kw: string, idx: number) => (
                                <span key={idx} className="bg-white/5 text-[9px] text-white/60 px-3 py-1.5 rounded-xl border border-white/5 hover:border-[#00d2ff]/30 transition-all uppercase font-bold tracking-tight">
                                  {kw.trim()}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-20 text-center opacity-20">
                        <svg className="w-16 h-16 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        <p className="text-xs font-bold uppercase tracking-widest">Metadata Pipeline Failed</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="p-12 text-center border-t border-white/5 bg-[#0a0a0a]">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-8">
          <p className="text-white/20 text-[10px] font-bold tracking-[0.5em] uppercase italic">Osman Infrastructure • Production v1.1.2</p>
          <p className="text-white/10 text-[10px] font-medium tracking-[0.3em] uppercase">
            Engine Logic developed by <span className="text-[#00d2ff] font-bold">Abdullah Al Osman</span>
          </p>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.05); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #00d2ff; }
        @keyframes fade-in { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fade-in 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes loading { from { width: 0%; } to { width: 100%; } }
      `}</style>
    </div>
  );
}
