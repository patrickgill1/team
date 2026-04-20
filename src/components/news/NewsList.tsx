import React, { useState, useEffect } from 'react';
import { News } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { formatDateTime, isCoach, truncateText } from '../../utils/helpers';
import NewsForm from './NewsForm';

interface NewsListProps {
  searchTerm?: string;
  limit?: number;
  showCreateButton?: boolean;
}

const NewsList: React.FC<NewsListProps> = ({ 
  searchTerm = '', 
  limit,
  showCreateButton = true 
}) => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getNewsByTeam, deleteDocument } = useFirestore();
  const [news, setNews] = useState<News[]>([]);
  const [loading, setLoading] = useState(true);
  const [filteredNews, setFilteredNews] = useState<News[]>([]);
  const [isNewsFormOpen, setIsNewsFormOpen] = useState(false);
  const [editingNews, setEditingNews] = useState<News | null>(null);
  const [expandedArticles, setExpandedArticles] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const isUserCoach = userData ? isCoach(userData.role) : false;

  // Load news on component mount
  useEffect(() => {
    const loadNews = async () => {
      if (!selectedTeamId) return;
      
      try {
        const teamNews = await getNewsByTeam(selectedTeamId);
        const newsWithDates = teamNews.map((article: any) => ({
          ...article,
          createdAt: article.createdAt?.toDate ? article.createdAt.toDate() : new Date(article.createdAt),
          updatedAt: article.updatedAt?.toDate ? article.updatedAt.toDate() : new Date(article.updatedAt)
        })) as News[];
        setNews(newsWithDates);
      } catch (error) {
        console.error('Error loading news:', error);
      } finally {
        setLoading(false);
      }
    };

    loadNews();
  }, [selectedTeamId, getNewsByTeam]);

  // Filter news based on search term
  useEffect(() => {
    let filtered = news.filter(article =>
      article.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      article.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (article.authorName && article.authorName.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    // Apply limit if specified
    if (limit) {
      filtered = filtered.slice(0, limit);
    }

    setFilteredNews(filtered);
  }, [news, searchTerm, limit]);

  const handleNewsUpdated = (updatedNews: News) => {
    if (editingNews) {
      // Update existing news
      setNews(prevNews =>
        prevNews.map(article =>
          article.id === updatedNews.id ? updatedNews : article
        )
      );
      setEditingNews(null);
    } else {
      // Add new news
      setNews(prevNews => [updatedNews, ...prevNews]);
    }
    setIsNewsFormOpen(false);
  };

  const handleEditNews = (article: News) => {
    setEditingNews(article);
    setIsNewsFormOpen(true);
  };

  const handleDeleteNews = async (articleId: string) => {
    if (!window.confirm('Are you sure you want to delete this news article? This action cannot be undone.')) {
      return;
    }

    setDeletingIds(prev => new Set(prev).add(articleId));
    try {
      await deleteDocument('news', articleId);
      setNews(prevNews => prevNews.filter(article => article.id !== articleId));
    } catch (error) {
      console.error('Error deleting news:', error);
    } finally {
      setDeletingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(articleId);
        return newSet;
      });
    }
  };

  const toggleExpanded = (articleId: string) => {
    setExpandedArticles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(articleId)) {
        newSet.delete(articleId);
      } else {
        newSet.add(articleId);
      }
      return newSet;
    });
  };

  const formatContent = (content: string, isExpanded: boolean) => {
    let formatted = content;
    
    if (!isExpanded) {
      formatted = truncateText(content, 200);
    }

    // Simple formatting
    return formatted
      .split('\n')
      .map((paragraph, index) => {
        if (paragraph.trim() === '---') {
          return <hr key={index} className="my-3 border-gray-300" />;
        }
        if (paragraph.trim() === '') {
          return <br key={index} />;
        }
        
        // Apply formatting
        let formattedParagraph = paragraph
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        if (paragraph.trim().startsWith('- ')) {
          return (
            <ul key={index} className="list-disc list-inside mb-2 text-gray-700">
              <li dangerouslySetInnerHTML={{ __html: formattedParagraph.substring(2) }} />
            </ul>
          );
        }
        
        return (
          <p key={index} className="mb-2 text-gray-700" dangerouslySetInnerHTML={{ __html: formattedParagraph }} />
        );
      });
  };

  const canEditOrDelete = (article: News) => {
    // Check if user is coach and if they are the author of the article
    return isUserCoach && article.authorId === (userData?.uid || userData?.id);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Team News {!limit && `(${filteredNews.length})`}
        </h2>
        
        {/* Create News Button (Coach only) */}
        {isUserCoach && showCreateButton && (
          <button
            onClick={() => {
              setEditingNews(null);
              setIsNewsFormOpen(true);
            }}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 flex items-center space-x-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Create Article</span>
          </button>
        )}
      </div>

      {/* News Articles */}
      {filteredNews.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No News Articles</h3>
          <p className="text-gray-600 mb-4">
            {searchTerm
              ? 'No articles match your search criteria.'
              : 'No news articles have been published yet.'}
          </p>
          {isUserCoach && !searchTerm && showCreateButton && (
            <button
              onClick={() => {
                setEditingNews(null);
                setIsNewsFormOpen(true);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
            >
              Create First Article
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {filteredNews.map((article) => {
            const isExpanded = expandedArticles.has(article.id);
            const isDeleting = deletingIds.has(article.id);

            return (
              <article key={article.id} className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
                {/* Article Header */}
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="text-xl font-semibold text-gray-900 mb-2">
                        {article.title}
                      </h3>
                      <div className="flex items-center space-x-4 text-sm text-gray-600">
                        <span className="flex items-center space-x-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span>{article.authorName || 'Coach'}</span>
                        </span>
                        <span className="flex items-center space-x-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span>{formatDateTime(article.createdAt)}</span>
                        </span>
                        {article.updatedAt.getTime() !== article.createdAt.getTime() && (
                          <span className="text-xs text-gray-500">
                            (Updated {formatDateTime(article.updatedAt)})
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    {canEditOrDelete(article) && (
                      <div className="flex items-center space-x-2 ml-4">
                        <button
                          onClick={() => handleEditNews(article)}
                          disabled={isDeleting}
                          className="p-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors duration-200 disabled:opacity-50"
                          title="Edit Article"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteNews(article.id)}
                          disabled={isDeleting}
                          className="p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200 disabled:opacity-50"
                          title="Delete Article"
                        >
                          {isDeleting ? (
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-600"></div>
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Article Content */}
                <div className="px-6 py-4">
                  <div className="prose prose-sm max-w-none">
                    {formatContent(article.content, isExpanded)}
                  </div>

                  {/* Read more/less button */}
                  {article.content.length > 200 && (
                    <button
                      onClick={() => toggleExpanded(article.id)}
                      className="mt-3 text-blue-600 hover:text-blue-700 font-medium text-sm transition-colors duration-200"
                    >
                      {isExpanded ? 'Read Less' : 'Read More'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* News Form Modal */}
      <NewsForm
        isOpen={isNewsFormOpen}
        onClose={() => {
          setIsNewsFormOpen(false);
          setEditingNews(null);
        }}
        onNewsUpdated={handleNewsUpdated}
        editingNews={editingNews}
      />
    </div>
  );
};

export default NewsList;