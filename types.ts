
export interface ImageData {
  id: string;
  file: File;
  preview: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  metadata?: PhotoMetadata;
  error?: string;
  retryCount?: number;
}

export interface PhotoMetadata {
  title: string;
  keywords: string; // Comma separated list for CSV
}

export interface ApiResponse {
  title: string;
  keywords: string[];
}

export enum AppState {
  SPLASH = 'SPLASH',
  HOME = 'HOME',
  PROCESSING = 'PROCESSING',
  RESULTS = 'RESULTS',
  SETTINGS = 'SETTINGS'
}

export type ApiProvider = 'gemini' | 'groq' | 'openai';

export interface ModelOption {
  id: string;
  name: string;
  provider: ApiProvider;
  tier: 'high' | 'low';
  description: string;
}

export interface AppConfig {
  provider: ApiProvider;
  model: string;
  keys: {
    gemini: string; // Used strictly via user input now
    groq: string;
    openai: string;
  };
}
