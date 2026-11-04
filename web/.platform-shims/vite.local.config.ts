import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config';

export default mergeConfig(base, defineConfig({
  resolve: { alias: { '@appdeploy/client': fileURLToPath(new URL('./client.ts', import.meta.url)) } },
}));
