'use client';

import { useState, useRef, useEffect } from 'react';
import config from '@/utils/config';

const SESSION_LIMIT = 20;

export default function Home() {
  const [messages, setMessages] = useState([
    { role: 'model', content: config.initialGreeting }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [sessionCount, setSessionCount] = useState(0);
  const bottomRef = useRef(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!inputMessage.trim() || isLoading || sessionCount >= SESSION_LIMIT) return;

    const userMessage = { role: 'user', content: inputMessage.trim() };
    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /** 
         * Important: filter out any empty messages or initial greeting to not confuse the AI context too much.
         * The backend system prompt explains who we are. 
         */
        body: JSON.stringify({
          messages: [...messages, userMessage]
            .filter(m => m.content && !m.content.startsWith(config.initialGreeting.split('\n')[0]))
            .map(m => ({ role: m.role, content: m.content }))
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Network error. Please try again.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let accumulated = '';

      // Add empty model message to start streaming into
      setMessages(prev => [...prev, { role: 'model', content: '' }]);

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          accumulated += chunk;
          const current = accumulated;
          setMessages(prev => {
            const newMessages = [...prev];
            newMessages[newMessages.length - 1] = { ...newMessages[newMessages.length - 1], content: current };
            return newMessages;
          });
        }
      }
      setSessionCount(prev => prev + 1);
    } catch (error) {
      console.error('Fetch error:', error);
      const errorMsg = error.message?.includes('rate limit')
        ? 'Whoa, too many requests! Give it a few seconds and try again.'
        : 'Hmm, something went wrong. Try again in a moment.';
      setMessages(prev => [...prev, { role: 'model', content: errorMsg }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFollowupClick = (question) => {
    setInputMessage(question);
    // Let the state update first, then simulate submit
    setTimeout(() => {
      document.getElementById('chatForm').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true })
      );
    }, 100);
  };

  // Helper parser for terminal specific tags
  const parseMessageContent = (content) => {
    let text = content;
    const items = [];

    // Extract all [IMAGE: filename.jpg | caption] tags
    // Format: [IMAGE: filename.jpg | Short human caption]
    const imageRegex = /\[IMAGE:\s*([^|\]]+?)(?:\|([^\]]+))?\]/g;
    let match;
    while ((match = imageRegex.exec(text)) !== null) {
      const filename = match[1].trim();
      const caption = match[2] ? match[2].trim() : null;
      items.push({ type: 'image', value: filename, caption });
    }
    text = text.replace(/\[IMAGE:[^\]]+\]/g, '');

    // Extract [FOLLOWUP: question]
    const followUpRegex = /\[FOLLOWUP:\s*([^\]]+)\]/g;
    let finalFollowUp = null;
    while ((match = followUpRegex.exec(text)) !== null) {
      finalFollowUp = match[1].trim();
    }
    text = text.replace(followUpRegex, '');

    // Strip any markdown formatting (terminal is plain text)
    text = text.replace(/\*\*(.+?)\*\*/g, '$1'); // **bold**
    text = text.replace(/\*(.+?)\*/g, '$1');     // *italic*
    text = text.replace(/^#{1,6}\s+/gm, '');     // ### headings
    text = text.replace(/\n{3,}/g, '\n\n');        // collapse excess blank lines
    // Strip any partial/unclosed tags that appear mid-stream
    text = text.replace(/\[(IMAGE|CAPTION|FOLLOWUP):[^\]]*$/s, '');

    // Cap at 4 images per message
    const imageItems = items.filter(i => i.type === 'image').slice(0, 4);

    return {
      text: text.trim(),
      images: imageItems,
      followUpObj: finalFollowUp
    };
  };

  // Extract follow up from the very last message if it's from the model and we're not loading
  let currentFollowUp = null;
  if (messages.length > 0 && messages[messages.length - 1].role === 'model' && !isLoading) {
    const { followUpObj } = parseMessageContent(messages[messages.length - 1].content);
    currentFollowUp = followUpObj;
  }

  return (
    <div className="h-screen w-full bg-[#0a0a0a] text-[#39ff14] p-4 md:p-8 font-mono relative overflow-hidden flex flex-col">
      <div className="scanline" />

      {/* Header */}
      <header className="mb-4 border-b border-[#39ff14]/50 pb-4 shrink-0 mt-2 z-10 relative flex justify-between items-start">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-widest uppercase">{config.terminalTitle}</h1>
          <p className="text-xs opacity-50 mt-1">* No personal data is collected or stored.</p>
          <p className="text-[10px] opacity-40 mt-0.5">* Powered by Gemini 2.5 Flash</p>
        </div>
        <div className="text-right text-xs shrink-0 ml-4 border border-[#39ff14]/30 px-2 py-1 bg-black/50">
          <div className={`font-bold tracking-wide ${SESSION_LIMIT - sessionCount <= 10 ? 'text-red-400' : 'text-[#39ff14]'}`}>
            {SESSION_LIMIT - sessionCount} <span className="opacity-70 font-normal">cmds left</span>
          </div>
          <div className="text-[10px] opacity-50 mt-0.5 uppercase tracking-wide">
            (resets on refresh)
          </div>
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto mb-4 space-y-6 pr-4 z-10 relative">
        {messages.map((msg, index) => {
          const { text, images } = parseMessageContent(msg.content);
          const isLastMessage = index === messages.length - 1;

          return (
            <div key={index} className={`flex flex-col space-y-2 ${msg.role === 'user' ? 'text-[#00e5ff]' : 'text-[#39ff14]'}`}>
              <div className="flex w-full">
                <span className="opacity-70 mr-3 shrink-0 select-none hidden md:inline">
                  {msg.role === 'user' ? config.userPrefix : config.terminalPrefix}
                </span>
                <span className="opacity-70 mr-2 shrink-0 select-none md:hidden text-xs">
                  {msg.role === 'user' ? config.mobileUserPrefix : config.mobileAiPrefix}
                </span>

                {/* Text Block */}
                <div className="flex-1 whitespace-pre-wrap leading-relaxed">
                  <span className={`break-words ${(isLastMessage && isLoading && msg.role === 'model') ? 'typing-cursor' : ''}`}>
                    {text}
                  </span>

                  {/* Images block inside the message */}
                  {images.length > 0 && (
                    <div className="flex flex-wrap gap-4 mt-6 mb-2">
                      {images.map((img, i) => (
                        <div key={i} className="flex flex-col gap-1 w-48 md:w-64 cursor-pointer" onClick={() => setSelectedImage(img)}>
                          <div className="border border-[#39ff14]/50 p-1 bg-black w-full h-48 md:h-64 relative group">
                            <img
                              src={`/api/images/${img.value}`}
                              alt={img.caption || img.value}
                              className="w-full h-full object-cover filter transition-all duration-300 sepia hover:sepia-0"
                              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.innerText = `[IMAGE NOT FOUND: ${img.value}]`; }}
                            />
                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <span className="bg-black text-[#39ff14] border border-[#39ff14] px-2 py-1 text-xs">[CLICK TO ENLARGE]</span>
                            </div>
                          </div>
                          {/* Caption: use AI-provided or auto-generate from filename */}
                          <p className="text-[10px] opacity-60 text-center leading-tight px-1">
                            {img.caption ||
                              img.value
                                .replace(/\.[^.]+$/, '')           // strip extension
                                .replace(/[_\-]+/g, ' ')           // underscores/dashes → space
                                .replace(/\b\w/g, c => c.toUpperCase()) // title case
                            }
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Suggested Follow up button */}
        {currentFollowUp && !isLoading && (
          <div className="mt-4 pt-4 border-t border-dashed border-[#39ff14]/30 opacity-90 animate-pulse ml-2 md:ml-[144px]">
            <span className="text-xs mr-3 font-semibold tracking-wider">RECOMMENDED QUERY &gt;</span>
            <button
              onClick={() => handleFollowupClick(currentFollowUp)}
              className="px-3 py-1.5 mt-2 md:mt-0 text-xs border border-[#39ff14] bg-[#39ff14]/10 hover:bg-[#39ff14] hover:text-black transition-colors"
            >
              {currentFollowUp}
            </button>
          </div>
        )}

        {/* Loading Indicator */}
        {isLoading && messages[messages.length - 1].role === 'user' && (
          <div className="flex w-full animate-pulse text-[#39ff14]">
            <span className="opacity-70 mr-3 shrink-0 select-none hidden md:inline">{config.terminalPrefix}</span>
            <span className="opacity-70 mr-3 shrink-0 select-none md:hidden text-xs truncate w-16">{config.mobileAiPrefix}</span>
            <span>PROCESSING...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      {/* Input Area */}
      <footer className="shrink-0 z-10 relative bg-[#0a0a0a]">
        <form id="chatForm" onSubmit={handleSubmit} className="flex flex-col sm:flex-row border-t border-[#00e5ff]/50 pt-4 pb-2 text-[#00e5ff]">
          <label htmlFor="terminal-input" className="select-none flex items-center shrink-0 sm:mr-3 mb-2 sm:mb-0">
            <span className="opacity-70 hidden md:inline">{config.userPrefix}</span>
            <span className="opacity-70 md:hidden text-xs">{config.mobileUserPrefix}</span>
            <span className="ml-2 typing-cursor"></span>
          </label>
          <input
            id="terminal-input"
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            disabled={isLoading || sessionCount >= SESSION_LIMIT}
            autoComplete="off"
            spellCheck="false"
            className={`flex-1 bg-transparent border-none outline-none w-full text-base ${sessionCount >= SESSION_LIMIT
              ? 'text-red-400 placeholder-red-400'
              : 'text-[#00e5ff] placeholder-[#00e5ff]/30'
              }`}
            placeholder={
              sessionCount >= SESSION_LIMIT
                ? "SESSION LIMIT REACHED. PLEASE REFRESH PAGE TO CONTINUE."
                : isLoading
                  ? "Awaiting system response..."
                  : "Enter your command or question..."
            }
            autoFocus
          />
        </form>
      </footer>

      {/* Fullscreen Image Modal Overlay */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 cursor-pointer backdrop-blur-sm"
          onClick={() => setSelectedImage(null)}
        >
          <div className="absolute top-4 right-4 text-[#39ff14] text-xl font-bold p-4">[X] CLOSE</div>
          <div className="max-w-4xl max-h-[80vh] border border-[#39ff14] p-2 bg-black relative shadow-[0_0_30px_rgba(57,255,20,0.2)]">
            <img
              src={`/api/images/${selectedImage.value || selectedImage}`}
              alt={selectedImage.caption || selectedImage.value || selectedImage}
              className="max-w-full max-h-[75vh] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="mt-4 text-[#39ff14] font-mono text-sm border-b border-[#39ff14]/50 pb-1">
            {selectedImage.caption ||
              (selectedImage.value || selectedImage)
                .replace(/\.[^/.]+$/, '')
                .replace(/[_-]+/g, ' ')
                .toUpperCase()
            }
          </p>
        </div>
      )}
    </div>
  );
}
