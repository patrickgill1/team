import React, { useState, useEffect } from 'react';
import { News } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';

interface NewsFormProps {
  isOpen: boolean;
  onClose: () => void;
  onNewsUpdated: (news: News) => void;
  editingNews?: News | null;
}

const NewsForm: React.FC<NewsFormProps> = ({
  isOpen,
  onClose,
  onNewsUpdated,
  editingNews
}) => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { addNews, updateNews } = useFirestore();

  const [formData, setFormData] = useState({
    title: '',
    content: '',
    summary: '',
    isPinned: false,
    isPublished: true
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (editingNews) {
      setFormData({
        title: editingNews.title,
        content: editingNews.content,
        summary: editingNews.summary || '',
        isPinned: editingNews.isPinned,
        isPublished: editingNews.isPublished
      });
    } else {
      setFormData({
        title: '',
        content: '',
        summary: '',
        isPinned: false,
        isPublished: true
      });
    }
    setErrors({});
  }, [editingNews, isOpen]);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    } else if (formData.title.trim().length < 5) {
      newErrors.title = 'Title must be at least 5 characters';
    }

    if (!formData.content.trim()) {
      newErrors.content = 'Content is required';
    } else if (formData.content.trim().length < 20) {
      newErrors.content = 'Content must be at least 20 characters';
    }

    if (formData.summary && formData.summary.length > 200) {
      newErrors.summary = 'Summary must be less than 200 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm() || !userData) return;

    setIsSubmitting(true);
    try {
      const newsData = {
        title: formData.title.trim(),
        content: formData.content.trim(),
        summary: formData.summary.trim() || undefined,
        authorId: userData.uid,
        authorName: userData.name,
        teamId: selectedTeamId,
        isPinned: formData.isPinned,
        isPublished: formData.isPublished
      };

      if (editingNews) {
        await updateNews(editingNews.id, newsData);
        onNewsUpdated({
          ...editingNews,
          ...newsData,
          updatedAt: new Date()
        });
      } else {
        const newsId = await addNews(newsData);
        onNewsUpdated({
          id: newsId,
          ...newsData,
          publishedAt: formData.isPublished ? new Date() : undefined,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      onClose();
    } catch (error) {
      console.error('Error saving news:', error);
      setErrors({ submit: 'Failed to save news article. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900/80 rounded-lg max-w-2xl w-full max-h-screen overflow-y-auto">
        <div className="sticky top-0 bg-gray-900/95 backdrop-blur border-b border-white/10 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">
              {editingNews ? 'Edit News Article' : 'Create News Article'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-300 transition-colors duration-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">
              Title *
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.title ? 'border-red-500' : 'border-white/15'
              }`}
              placeholder="Enter news title"
              disabled={isSubmitting}
            />
            {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
          </div>

          {/* Summary */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">
              Summary (Optional)
            </label>
            <textarea
              value={formData.summary}
              onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
              rows={2}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.summary ? 'border-red-500' : 'border-white/15'
              }`}
              placeholder="Brief summary for preview (optional)"
              disabled={isSubmitting}
            />
            <p className="text-sm text-gray-400 mt-1">
              {formData.summary.length}/200 characters
            </p>
            {errors.summary && <p className="text-red-500 text-sm mt-1">{errors.summary}</p>}
          </div>

          {/* Content */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">
              Content *
            </label>
            <textarea
              value={formData.content}
              onChange={(e) => setFormData({ ...formData, content: e.target.value })}
              rows={10}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.content ? 'border-red-500' : 'border-white/15'
              }`}
              placeholder="Write your news article content here..."
              disabled={isSubmitting}
            />
            {errors.content && <p className="text-red-500 text-sm mt-1">{errors.content}</p>}
          </div>

          {/* Options */}
          <div className="space-y-3">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="isPinned"
                checked={formData.isPinned}
                onChange={(e) => setFormData({ ...formData, isPinned: e.target.checked })}
                disabled={isSubmitting}
                className="h-4 w-4 text-cyan-300 focus:ring-blue-500 border-white/15 rounded"
              />
              <label htmlFor="isPinned" className="ml-2 block text-sm text-gray-200">
                Pin this article (appears at top)
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="isPublished"
                checked={formData.isPublished}
                onChange={(e) => setFormData({ ...formData, isPublished: e.target.checked })}
                disabled={isSubmitting}
                className="h-4 w-4 text-cyan-300 focus:ring-blue-500 border-white/15 rounded"
              />
              <label htmlFor="isPublished" className="ml-2 block text-sm text-gray-200">
                Publish immediately
              </label>
            </div>
          </div>

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-3">
              <p className="text-rose-300 text-sm">{errors.submit}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex space-x-4 pt-4 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
            >
              {isSubmitting ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              ) : (
                editingNews ? 'Update Article' : 'Create Article'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewsForm;