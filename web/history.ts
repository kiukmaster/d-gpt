import { invoke } from '@tauri-apps/api/core';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  image?: { mime: string; data: string };
  interrupted?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  updated: number;
  turns: Turn[];
}

export const listThreads = () => invoke<Omit<Thread, 'turns'>[]>('list_threads');
export const readThread = (id: string) => invoke<Thread>('read_thread', { id });
export const writeThread = (thread: Thread) => invoke<void>('write_thread', { thread });
export const deleteThread = (id: string) => invoke<void>('delete_thread', { id });
