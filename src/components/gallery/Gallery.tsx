import React, { useState, useEffect } from 'react';
import { GalleryPhoto } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { useStorage } from '../../hooks/useStorage';
import { formatDateTime, canManageTeamMedia } from '../../utils/helpers';
import PhotoUpload from './PhotoUpload';

interface GalleryProps {
  searchTerm?: string;
  tagFilter?: string;
  showUploadButton?: boolean;
}

const Gallery: React.FC<GalleryProps> = ({ 
  searchTerm = '', 
  tagFilter = '',
  showUploadButton = true 
}) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const canManageMedia = canManageTeamMedia(userData, selectedTeam);
  const { getPhotosByTeam, deleteDocument } = useFirestore();
  const { deleteFile } = useStorage();
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [filteredPhotos, setFilteredPhotos] = useState<GalleryPhoto[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<GalleryPhoto | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'grid' | 'masonry'>('grid');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest'>('newest');

  // Load photos on component mount
  useEffect(() => {
    const loadPhotos = async () => {
      if (!selectedTeamId) return;
      
      try {
        const teamPhotos = await getPhotosByTeam(selectedTeamId);
        const photosWithDates = teamPhotos.map((photo: any) => ({
          ...photo,
          createdAt: photo.createdAt?.toDate ? photo.createdAt.toDate() : new Date(photo.createdAt)
        })) as GalleryPhoto[];
        setPhotos(photosWithDates);
      } catch (error) {
        console.error('Error loading photos:', error);
      } finally {
        setLoading(false);
      }
    };

    loadPhotos();
  }, [selectedTeamId, getPhotosByTeam]);

  // Filter and sort photos
  useEffect(() => {
    let filtered = photos.filter(photo => {
      const matchesSearch = searchTerm === '' || 
        photo.caption.toLowerCase().includes(searchTerm.toLowerCase()) ||
        photo.uploadedByName?.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesTag = tagFilter === '' || 
        photo.tags.some(tag => tag.toLowerCase().includes(tagFilter.toLowerCase()));

      return matchesSearch && matchesTag;
    });

    // Sort photos
    filtered.sort((a, b) => {
      if (sortBy === 'newest') {
        return b.createdAt.getTime() - a.createdAt.getTime();
      } else {
        return a.createdAt.getTime() - b.createdAt.getTime();
      }
    });

    setFilteredPhotos(filtered);
  }, [photos, searchTerm, tagFilter, sortBy]);

  const handlePhotosUploaded = (newPhotos: GalleryPhoto[]) => {
    setPhotos(prevPhotos => [...newPhotos, ...prevPhotos]);
    setIsUploadOpen(false);
  };

  const handleDeletePhoto = async (photo: GalleryPhoto) => {
    if (!window.confirm('Are you sure you want to delete this photo? This action cannot be undone.')) {
      return;
    }

    setDeletingIds(prev => new Set(prev).add(photo.id));
    try {
      // Delete from Firestore
      await deleteDocument('gallery', photo.id);
      
      // Delete from Storage (optional - Firebase Storage has lifecycle rules)
      try {
        await deleteFile(photo.url);
      } catch (storageError) {
        console.warn('Could not delete file from storage:', storageError);
      }
      
      setPhotos(prevPhotos => prevPhotos.filter(p => p.id !== photo.id));
      
      // Close modal if deleted photo was selected
      if (selectedPhoto?.id === photo.id) {
        setSelectedPhoto(null);
      }
    } catch (error) {
      console.error('Error deleting photo:', error);
    } finally {
      setDeletingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(photo.id);
        return newSet;
      });
    }
  };

const canDeletePhoto = (photo: GalleryPhoto) => {
    // Check using both uid and id for compatibility
    return userData && (userData.uid === photo.uploadedBy || userData.id === photo.uploadedBy);
  };

  const getAllTags = () => {
    const allTags = photos.flatMap(photo => photo.tags);
    return Array.from(new Set(allTags)).sort();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-charcoal-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-center space-x-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Team Gallery ({filteredPhotos.length})
          </h2>
          
          {/* View Mode Toggle */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors duration-200 ${
                viewMode === 'grid'
                  ? 'bg-white text-charcoal-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Grid
            </button>
            <button
              onClick={() => setViewMode('masonry')}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors duration-200 ${
                viewMode === 'masonry'
                  ? 'bg-white text-charcoal-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Masonry
            </button>
          </div>

          {/* Sort Toggle */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'newest' | 'oldest')}
            className="px-3 py-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
          </select>
        </div>

        {/* Upload Button */}
        {showUploadButton && canManageMedia && (
          <button
            onClick={() => setIsUploadOpen(true)}
            className="bg-charcoal-600 hover:bg-charcoal-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 flex items-center space-x-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Upload Photos</span>
          </button>
        )}
      </div>

      {/* Tags Filter */}
      {getAllTags().length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="text-sm font-medium text-gray-700">Filter by tag:</span>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('tagFilter', { detail: '' }))}
            className={`px-2 py-1 text-xs rounded-full transition-colors duration-200 ${
              tagFilter === '' 
                ? 'bg-brand-primary-soft text-charcoal-800' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {getAllTags().slice(0, 10).map(tag => (
            <button
              key={tag}
              onClick={() => window.dispatchEvent(new CustomEvent('tagFilter', { detail: tag }))}
              className={`px-2 py-1 text-xs rounded-full transition-colors duration-200 ${
                tagFilter === tag 
                  ? 'bg-brand-primary-soft text-charcoal-800' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Photo Gallery */}
      {filteredPhotos.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Photos Found</h3>
          <p className="text-gray-600 mb-4">
            {searchTerm || tagFilter
              ? 'No photos match your current filters.'
              : 'No photos have been uploaded to the gallery yet.'}
          </p>
          {!searchTerm && !tagFilter && showUploadButton && canManageMedia && (
            <button
              onClick={() => setIsUploadOpen(true)}
              className="bg-charcoal-600 hover:bg-charcoal-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
            >
              Upload First Photos
            </button>
          )}
        </div>
      ) : (
        <div className={
          viewMode === 'grid' 
            ? 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4'
            : 'columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4'
        }>
          {filteredPhotos.map((photo) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              onClick={() => setSelectedPhoto(photo)}
              onDelete={() => handleDeletePhoto(photo)}
              canDelete={canDeletePhoto(photo)}
              isDeleting={deletingIds.has(photo.id)}
              viewMode={viewMode}
            />
          ))}
        </div>
      )}

      {/* Photo Modal */}
      {selectedPhoto && (
        <PhotoModal
          photo={selectedPhoto}
          onClose={() => setSelectedPhoto(null)}
          onDelete={() => handleDeletePhoto(selectedPhoto)}
          canDelete={canDeletePhoto(selectedPhoto)}
          isDeleting={deletingIds.has(selectedPhoto.id)}
        />
      )}

      {/* Upload Modal */}
      <PhotoUpload
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onPhotosUploaded={handlePhotosUploaded}
      />
    </div>
  );
};

// Photo Card Component
interface PhotoCardProps {
  photo: GalleryPhoto;
  onClick: () => void;
  onDelete: () => void;
  canDelete: boolean;
  isDeleting: boolean;
  viewMode: 'grid' | 'masonry';
}

const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  onClick,
  onDelete,
  canDelete,
  isDeleting,
  viewMode
}) => {
  return (
    <div className={`group relative bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-all duration-200 ${
      viewMode === 'masonry' ? 'break-inside-avoid mb-4' : ''
    }`}>
      <div className="relative">
        <img
          src={photo.url}
          alt={photo.caption}
          className={`w-full object-cover cursor-pointer ${
            viewMode === 'grid' ? 'h-48' : 'h-auto'
          }`}
          onClick={onClick}
          loading="lazy"
        />
        
        {/* Overlay on hover */}
        <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all duration-200 flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex space-x-2">
            <button
              onClick={onClick}
              className="p-2 bg-white bg-opacity-90 rounded-full hover:bg-opacity-100 transition-all duration-200"
            >
              <svg className="w-5 h-5 text-gray-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            {canDelete && (
              <button
                onClick={onDelete}
                disabled={isDeleting}
                className="p-2 bg-red-500 bg-opacity-90 rounded-full hover:bg-opacity-100 transition-all duration-200 disabled:opacity-50"
              >
                {isDeleting ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                ) : (
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Photo Info */}
      <div className="p-3">
        {photo.caption && (
          <p className="text-sm text-gray-800 mb-2 line-clamp-2">{photo.caption}</p>
        )}
        
        {photo.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {photo.tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="px-2 py-1 bg-brand-primary-soft text-charcoal-800 text-xs rounded-full"
              >
                {tag}
              </span>
            ))}
            {photo.tags.length > 3 && (
              <span className="text-xs text-gray-500">+{photo.tags.length - 3}</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{photo.uploadedByName}</span>
          <span>{formatDateTime(photo.createdAt)}</span>
        </div>
      </div>
    </div>
  );
};

// Photo Modal Component
interface PhotoModalProps {
  photo: GalleryPhoto;
  onClose: () => void;
  onDelete: () => void;
  canDelete: boolean;
  isDeleting: boolean;
}

const PhotoModal: React.FC<PhotoModalProps> = ({
  photo,
  onClose,
  onDelete,
  canDelete,
  isDeleting
}) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="max-w-4xl w-full max-h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between text-white mb-4">
          <div className="flex items-center space-x-4">
            <h3 className="text-lg font-semibold">
              {photo.caption || 'Team Photo'}
            </h3>
          </div>
          <div className="flex items-center space-x-2">
            {canDelete && (
              <button
                onClick={onDelete}
                disabled={isDeleting}
                className="p-2 text-white hover:text-red-400 transition-colors duration-200 disabled:opacity-50"
                title="Delete Photo"
              >
                {isDeleting ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                )}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 text-white hover:text-gray-300 transition-colors duration-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Photo */}
        <div className="flex-1 flex items-center justify-center mb-4">
          <img
            src={photo.url}
            alt={photo.caption}
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        </div>

        {/* Photo Details */}
        <div className="bg-white rounded-lg p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex-1">
              <div className="flex items-center space-x-2 text-sm text-gray-600 mb-2">
                <span>📷 {photo.uploadedByName}</span>
                <span>•</span>
                <span>{formatDateTime(photo.createdAt)}</span>
              </div>
              {photo.caption && (
                <p className="text-gray-800 mb-2">{photo.caption}</p>
              )}
            </div>
          </div>
          
          {photo.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photo.tags.map(tag => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-brand-primary-soft text-charcoal-800 text-sm rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Gallery;