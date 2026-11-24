import { invoke } from '@tauri-apps/api/core';

export interface Usage {
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  uncachedInput?: number;
  ordinaryInput?: number;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  image?: { mime: string; data: string };
  interrupted?: boolean;
  usage?: Usage;
}

export interface Thread {
  id: string;
  title: string;
  updated: number;
  turns: Turn[];
  checkpoint?: ContextCheckpoint;
}

export interface ContextCheckpoint {
  through: number;
  text: string;
  usage?: Usage;
}

export const listThreads = () => invoke<Omit<Thread, 'turns' | 'checkpoint'>[]>('list_threads');
export const readThread = async (id: string) => {
  const thread = await invoke<Thread>('read_thread', { id });
  const checkpoint = thread.checkpoint;
  if (checkpoint && (!Number.isSafeInteger(checkpoint.through) || checkpoint.through < 1 ||
      checkpoint.through > thread.turns.length || typeof checkpoint.text !== 'string' || !checkpoint.text.trim())) {
    delete thread.checkpoint;
  }
  return thread;
};
export const writeThread = (thread: Thread) => invoke<void>('write_thread', { thread });
export const deleteThread = (id: string) => invoke<void>('delete_thread', { id });
