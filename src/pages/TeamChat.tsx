import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { ChatThread, ChatMessage } from '../types';
import MessageBubble from '../components/chat/MessageBubble';
import MessageComposer, { ComposerAttachment } from '../components/chat/MessageComposer';

const TeamChat: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { 
    addChatThread, 
    updateChatThread, 
    addChatMessage, 
    subscribeToChatThreads,
    subscribeToChatMessages,
    updateDocument,
    getDocuments,
  } = useFirestore();
  
  // Simple mobile-first state management
  const [currentView, setCurrentView] = useState<'threads' | 'chat'>('threads');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState<{ uid: string; name: string; role?: string; email?: string }[]>([]);
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  // New thread form
  const [newThread, setNewThread] = useState({
    title: '',
    description: '',
    isPrivate: false,
    tags: [] as string[]
  });

  const isCoach = userData?.role === 'coach';

  // Detect mobile
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // On desktop, always show threads view alongside chat
      if (!mobile) {
        setCurrentView('threads');
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Simple navigation functions
  const showThreadsList = () => {
    console.log('Showing threads list');
    setCurrentView('threads');
    setSelectedThread(null);
  };

  const showChatView = (thread: ChatThread) => {
    console.log('Showing chat view for thread:', thread.title);
    setSelectedThread(thread);
    setCurrentView('chat');
  };

  // Scroll to bottom of messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const formatTime = (date: Date | any) => {
    try {
      const dateObj = date instanceof Date ? date : new Date(date);
      if (isNaN(dateObj.getTime())) {
        return 'Unknown';
      }
      
      const now = new Date();
      const diff = now.getTime() - dateObj.getTime();
      const hours = diff / (1000 * 60 * 60);
      
      if (hours < 1) {
        const minutes = Math.floor(diff / (1000 * 60));
        return minutes < 1 ? 'Just now' : `${minutes}m ago`;
      } else if (hours < 24) {
        return `${Math.floor(hours)}h ago`;
      } else {
        return dateObj.toLocaleDateString();
      }
    } catch (error) {
      console.error('Error formatting time:', error);
      return 'Unknown';
    }
  };

  // Load threads
  useEffect(() => {
    if (selectedTeamId) {
      setLoading(true);
      
      const unsubscribeThreads = subscribeToChatThreads(selectedTeamId, (threadsData) => {
        console.log('Received threads data:', threadsData);
        
        const filteredThreads = threadsData.filter((thread: ChatThread) => {
          if (thread.isPrivate && !isCoach) return false;
          return true;
        });

        const processedThreads = filteredThreads.map(thread => ({
          ...thread,
          lastActivity: thread.lastActivity instanceof Date ? thread.lastActivity : new Date(thread.lastActivity || Date.now()),
          createdAt: thread.createdAt instanceof Date ? thread.createdAt : new Date(thread.createdAt || Date.now()),
          messageCount: thread.messageCount || 0
        }));

        setThreads(processedThreads);
        setLoading(false);
        
        // NEVER auto-select a thread on mobile - always start with threads list
        if (!isMobile && processedThreads.length > 0 && !selectedThread) {
          setSelectedThread(processedThreads[0]);
        }
      });

      return () => {
        unsubscribeThreads();
      };
    }
  }, [selectedTeamId, isCoach, subscribeToChatThreads, isMobile]);

  // Load team members for @mention autocomplete + email
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all: any[] = await getDocuments('users', []).catch(() => []);
        if (cancelled) return;
        const filtered = all
          .filter((u) => u && u.name && (
            (Array.isArray(u.teamIds) && u.teamIds.includes(selectedTeamId)) ||
            u.teamId === selectedTeamId
          ))
          .map((u) => ({
            uid: u.uid || u.id,
            name: u.name,
            role: u.role,
            email: (u.email || '').trim().toLowerCase(),
          }));
        setTeamMembers(filtered);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, getDocuments]);

  // Load messages for selected thread
  useEffect(() => {
    if (selectedThread) {
      const unsubscribeMessages = subscribeToChatMessages(selectedThread.id, (messagesData) => {
        console.log('Received messages data:', messagesData);
        
        const processedMessages = messagesData.map(message => ({
          ...message,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp || Date.now()),
          createdAt: message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt || Date.now())
        }));
        
        setMessages(processedMessages);
      });

      return () => {
        unsubscribeMessages();
      };
    }
  }, [selectedThread, subscribeToChatMessages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const createThread = async () => {
    if (!newThread.title.trim() || !userData) return;

    try {
      const threadData: Omit<ChatThread, 'id' | 'createdAt' | 'updatedAt'> = {
        title: newThread.title,
        description: newThread.description,
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        lastActivity: new Date(),
        isPinned: false,
        isPrivate: newThread.isPrivate,
        messageCount: 0,
        participants: [userData.uid],
        tags: newThread.tags
      };

      await addChatThread(threadData);
      
      setNewThread({ title: '', description: '', isPrivate: false, tags: [] });
      setIsCreatingThread(false);
    } catch (error) {
      console.error('Error creating thread:', error);
    }
  };

  const sendMessage = async (contentArg?: string, attachmentsArg?: ComposerAttachment[]) => {
    const content = (contentArg !== undefined ? contentArg : newMessage).trim();
    const attachments = attachmentsArg || [];
    if ((!content && attachments.length === 0) || !selectedThread || !userData) return;

    try {
      const messageData: any = {
        threadId: selectedThread.id,
        content,
        senderId: userData.uid,
        senderName: userData.name,
        senderRole: userData.role,
        timestamp: new Date(),
        teamId: selectedTeamId,
      };
      if (replyingTo?.id) messageData.replyTo = replyingTo.id;
      if (attachments.length > 0) messageData.attachments = attachments;

      await addChatMessage(messageData);
      
      const lastSnippet = content || (attachments.length > 0 ? `📷 ${attachments.length} image${attachments.length > 1 ? 's' : ''}` : '');
      await updateChatThread(selectedThread.id, {
        lastActivity: new Date(),
        messageCount: selectedThread.messageCount + 1,
        participants: Array.from(new Set([...selectedThread.participants, userData.uid])),
        lastMessage: {
          content: lastSnippet,
          senderName: userData.name,
          timestamp: new Date()
        }
      });

      // Email mentioned users (best-effort, dynamic import)
      if (content) {
        const mentionRe = /@([A-Za-z][A-Za-z0-9 _'-]{0,28}[A-Za-z0-9])/g;
        const names = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = mentionRe.exec(content)) !== null) {
          names.add(m[1].toLowerCase());
        }
        if (names.size > 0 && teamMembers.length > 0) {
          const targets = teamMembers.filter(
            (u) =>
              u.email &&
              u.uid !== userData.uid &&
              names.has((u.name || '').toLowerCase())
          );
          if (targets.length > 0) {
            try {
              const { sendEmailBatch } = await import('../utils/notify');
              const APP = window.location.origin;
              const safe = content.replace(/</g, '&lt;');
              await sendEmailBatch(
                targets.map((u) => ({
                  to: u.email!,
                  subject: `${userData.name} mentioned you in ${selectedThread.title}`,
                  html: `<div style="font-family:-apple-system,sans-serif;color:#111827;"><p><b>${userData.name}</b> mentioned you in <b>${selectedThread.title}</b>:</p><blockquote style="border-left:3px solid #1e3a5f;padding-left:12px;color:#374151;white-space:pre-wrap;">${safe}</blockquote><p><a href="${APP}/chat" style="display:inline-block;background:#1e3a5f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Open chat</a></p></div>`,
                }))
              );
            } catch (e) {
              console.warn('[chat] mention email failed', e);
            }
          }
        }
      }
      
      setNewMessage('');
      setReplyingTo(null);
      messageInputRef.current?.focus();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const toggleReaction = async (message: ChatMessage, emoji: string) => {
    if (!userData) return;
    const existing = message.reactions || [];
    const mineIdx = existing.findIndex((r) => r.userId === userData.uid && r.emoji === emoji);
    let next;
    if (mineIdx >= 0) {
      next = existing.filter((_, i) => i !== mineIdx);
    } else {
      next = [...existing, { emoji, userId: userData.uid, userName: userData.name }];
    }
    try {
      await updateDocument('chat_messages', message.id, { reactions: next });
    } catch (err) {
      console.error('Error toggling reaction:', err);
    }
  };

  const togglePinThread = async (thread: ChatThread) => {
    if (!isCoach) return;

    try {
      await updateChatThread(thread.id, { isPinned: !thread.isPinned });
    } catch (error) {
      console.error('Error toggling pin:', error);
    }
  };

  const filteredThreads = threads.filter(thread => {
    const matchesSearch = thread.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         thread.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterTag === 'all' || 
                         (filterTag === 'pinned' && thread.isPinned) ||
                         (filterTag === 'private' && thread.isPrivate) ||
                         thread.tags?.includes(filterTag);
    return matchesSearch && matchesFilter;
  });

  console.log('Current state:', { currentView, isMobile, selectedThread: selectedThread?.title });

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-2"></div>
          <p className="text-gray-600">Loading chat...</p>
        </div>
      </div>
    );
  }

  // MOBILE: Single view at a time
  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-gray-50">
        {currentView === 'threads' ? (
          // THREADS LIST VIEW
          <div className="flex-1 flex flex-col bg-white">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-900">Team Chat</h2>
                <button
                  onClick={() => setIsCreatingThread(true)}
                  className="bg-blue-600 hover:bg-blue-700 text-white p-2.5 rounded-lg transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </button>
              </div>

              {/* Search */}
              <div className="relative mb-3">
                <input
                  type="text"
                  placeholder="Search threads..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                  style={{ fontSize: '16px' }}
                />
                <svg className="w-5 h-5 text-gray-400 absolute left-3 top-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>

              {/* Filters */}
              <div className="flex space-x-2">
                {['all', 'pinned', 'private'].map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setFilterTag(filter)}
                    className={`px-3 py-2 text-sm rounded-full transition-colors ${
                      filterTag === filter
                        ? 'bg-blue-100 text-blue-700 font-medium'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {filter.charAt(0).toUpperCase() + filter.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Threads List */}
            <div className="flex-1 overflow-y-auto">
              {filteredThreads.map((thread) => (
                <div
                  key={thread.id}
                  onClick={() => showChatView(thread)}
                  className="p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 active:bg-gray-100 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2 mb-1">
                        <h3 className="font-semibold text-gray-900 truncate text-base">{thread.title}</h3>
                        {thread.isPinned && (
                          <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        )}
                        {thread.isPrivate && (
                          <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                          </svg>
                        )}
                      </div>
                      
                      {thread.description && (
                        <p className="text-sm text-gray-600 truncate mb-2">{thread.description}</p>
                      )}
                      
                      {thread.lastMessage && (
                        <p className="text-sm text-gray-500 truncate mb-2">
                          <span className="font-medium">{thread.lastMessage.senderName}:</span> {thread.lastMessage.content}
                        </p>
                      )}
                      
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">{thread.messageCount || 0} messages</span>
                        <span className="text-xs text-gray-500">{formatTime(thread.lastActivity)}</span>
                      </div>
                    </div>
                    
                    <div className="ml-3 flex-shrink-0">
                      <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                </div>
              ))}
              
              {filteredThreads.length === 0 && (
                <div className="p-8 text-center">
                  <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-gray-500 text-sm">No threads found</p>
                  <button
                    onClick={() => setIsCreatingThread(true)}
                    className="mt-3 text-blue-600 text-sm font-medium"
                  >
                    Create your first thread
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          // CHAT VIEW
          selectedThread && (
            <div className="flex-1 flex flex-col bg-white">
              {/* Chat Header with Back Button */}
              <div className="bg-white border-b border-gray-200 p-4">
                <div className="flex items-center space-x-3">
                  <button
                    onClick={showThreadsList}
                    className="flex items-center justify-center w-10 h-10 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors flex-shrink-0"
                  >
                    <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <h1 className="text-lg font-semibold text-gray-900 truncate">{selectedThread.title}</h1>
                      {selectedThread.isPinned && (
                        <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      )}
                      {selectedThread.isPrivate && (
                        <span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded-full flex-shrink-0">Coach Only</span>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-gray-500 mt-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      <span>{selectedThread.participants.length} participants</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    currentUserId={userData?.uid || ''}
                    currentUserName={userData?.name || ''}
                    replyTarget={message.replyTo ? messages.find((mm) => mm.id === message.replyTo) || null : null}
                    onReply={setReplyingTo}
                    onToggleReaction={toggleReaction}
                    formatTime={formatTime}
                    compact
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Message Input */}
              <MessageComposer
                threadId={selectedThread.id}
                teamId={selectedTeamId}
                members={teamMembers}
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
                onSend={(c, atts) => sendMessage(c, atts)}
                rows={2}
              />
            </div>
          )
        )}

        {/* Create Thread Modal */}
        {isCreatingThread && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-lg w-full max-w-md max-h-screen overflow-y-auto">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium text-gray-900">Create New Thread</h3>
                  <button
                    onClick={() => setIsCreatingThread(false)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Thread Title
                    </label>
                    <input
                      type="text"
                      value={newThread.title}
                      onChange={(e) => setNewThread(prev => ({ ...prev, title: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                      placeholder="Enter thread title..."
                      style={{ fontSize: '16px' }}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description (Optional)
                    </label>
                    <textarea
                      value={newThread.description}
                      onChange={(e) => setNewThread(prev => ({ ...prev, description: e.target.value }))}
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                      placeholder="What's this thread about?"
                      style={{ fontSize: '16px' }}
                    />
                  </div>

                  {isCoach && (
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="isPrivate"
                        checked={newThread.isPrivate}
                        onChange={(e) => setNewThread(prev => ({ ...prev, isPrivate: e.target.checked }))}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <label htmlFor="isPrivate" className="ml-2 text-sm text-gray-700">
                        Coach-only thread
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex space-x-3 mt-6">
                  <button
                    onClick={() => setIsCreatingThread(false)}
                    className="flex-1 px-4 py-2.5 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={createThread}
                    disabled={!newThread.title.trim()}
                    className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors font-medium"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // DESKTOP: Side-by-side layout
  return (
    <div className="h-screen flex bg-gray-50">
      {/* Desktop Sidebar */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Team Chat</h2>
            <button
              onClick={() => setIsCreatingThread(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </button>
          </div>

          <div className="relative mb-3">
            <input
              type="text"
              placeholder="Search threads..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <div className="flex space-x-2">
            {['all', 'pinned', 'private'].map((filter) => (
              <button
                key={filter}
                onClick={() => setFilterTag(filter)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  filterTag === filter
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {filter.charAt(0).toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop Threads List */}
        <div className="flex-1 overflow-y-auto">
          {filteredThreads.map((thread) => (
            <div
              key={thread.id}
              onClick={() => setSelectedThread(thread)}
              className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${
                selectedThread?.id === thread.id ? 'bg-blue-50 border-l-4 border-l-blue-600' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <h3 className="font-medium text-gray-900 truncate">{thread.title}</h3>
                    {thread.isPinned && (
                      <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    {thread.isPrivate && (
                      <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    )}
                  </div>
                  
                  {thread.description && (
                    <p className="text-sm text-gray-600 truncate mb-2">{thread.description}</p>
                  )}
                  
                  {thread.lastMessage && (
                    <p className="text-xs text-gray-500 truncate mb-2">
                      <span className="font-medium">{thread.lastMessage.senderName}:</span> {thread.lastMessage.content}
                    </p>
                  )}
                  
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{thread.messageCount || 0} messages</span>
                    <span className="text-xs text-gray-500">{formatTime(thread.lastActivity)}</span>
                  </div>
                </div>
                
                {isCoach && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinThread(thread);
                    }}
                    className={`ml-2 p-1 rounded transition-colors ${
                      thread.isPinned ? 'text-yellow-500 hover:text-yellow-600' : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedThread ? (
          <>
            {/* Desktop Chat Header */}
            <div className="bg-white border-b border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <h1 className="text-xl font-semibold text-gray-900">{selectedThread.title}</h1>
                    {selectedThread.isPinned && (
                      <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    {selectedThread.isPrivate && (
                      <span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded-full">Coach Only</span>
                    )}
                  </div>
                  {selectedThread.description && (
                    <p className="text-sm text-gray-600 mt-1">{selectedThread.description}</p>
                  )}
                </div>
                
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  <span>{selectedThread.participants.length} participants</span>
                </div>
              </div>
            </div>

            {/* Desktop Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  currentUserId={userData?.uid || ''}
                  currentUserName={userData?.name || ''}
                  replyTarget={message.replyTo ? messages.find((mm) => mm.id === message.replyTo) || null : null}
                  onReply={setReplyingTo}
                  onToggleReaction={toggleReaction}
                  formatTime={formatTime}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Desktop Message Input */}
            {selectedThread && (
              <MessageComposer
                threadId={selectedThread.id}
                teamId={selectedTeamId}
                members={teamMembers}
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
                onSend={(c, atts) => sendMessage(c, atts)}
                rows={3}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <h3 className="text-lg font-medium text-gray-900 mb-2">Select a thread to start chatting</h3>
              <p className="text-gray-500">Choose a thread from the sidebar or create a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* Desktop Create Thread Modal */}
      {isCreatingThread && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Create New Thread</h3>
                <button
                  onClick={() => setIsCreatingThread(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Thread Title
                  </label>
                  <input
                    type="text"
                    value={newThread.title}
                    onChange={(e) => setNewThread(prev => ({ ...prev, title: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Enter thread title..."
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description (Optional)
                  </label>
                  <textarea
                    value={newThread.description}
                    onChange={(e) => setNewThread(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="What's this thread about?"
                  />
                </div>

                {isCoach && (
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="isPrivate"
                      checked={newThread.isPrivate}
                      onChange={(e) => setNewThread(prev => ({ ...prev, isPrivate: e.target.checked }))}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label htmlFor="isPrivate" className="ml-2 text-sm text-gray-700">
                      Coach-only thread
                    </label>
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => setIsCreatingThread(false)}
                  className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={createThread}
                  disabled={!newThread.title.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors"
                >
                  Create Thread
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TeamChat;