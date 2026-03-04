import { useEffect, useState } from 'react';
import { useWebSocketStore } from '@/stores/websocket';
import { ChatWindow } from '@/components/ChatWindow';
import { ApprovalDialog } from '@/components/ApprovalDialog';
import { DevConsole } from '@/components/DevConsole';

export default function App() {
  const [devConsoleOpen, setDevConsoleOpen] = useState(false);
  const connect = useWebSocketStore((s) => s.connect);

  useEffect(() => {
    const wsUrl = `ws://${window.location.hostname}:${import.meta.env.VITE_WS_PORT ?? '3000'}/ws`;
    connect(wsUrl);
  }, [connect]);

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: 'var(--background)' }}>
      {/* Header */}
      <header
        className="flex items-center px-4 py-3 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <h1 className="text-lg font-semibold">AhaAgent</h1>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        <ChatWindow />
      </main>

      {/* Overlays */}
      <ApprovalDialog />
      <DevConsole open={devConsoleOpen} onToggle={() => setDevConsoleOpen((o) => !o)} />
    </div>
  );
}
