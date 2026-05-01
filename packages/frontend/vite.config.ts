import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useHttps = env.VITE_HTTPS !== '0';

  return {
    plugins: useHttps ? [react(), basicSsl()] : [react()],
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client'],
      force: true,
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/api/, '/api'),
        },
        '/ws': {
          target: 'ws://127.0.0.1:3001',
          ws: true,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
    },
  };
});
