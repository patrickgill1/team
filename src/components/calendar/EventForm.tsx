import React, { useState, useEffect } from 'react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';

interface EventFormProps {
  isOpen: boolean;
  onClose: () => void;
  onEventUpdated: (event: CalendarEvent) => void;
  editingEvent?: CalendarEvent | null;
  selectedDate?: Date;
}

const EventForm: React.FC<EventFormProps> = ({
  isOpen,
  onClose,
  onEventUpdated,
  editingEvent,
  selectedDate
}) => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { addDocument, updateDocument } = useFirestore();

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    date: '',
    time: '',
    location: '',
    type: 'practice' as 'game' | 'practice' | 'event',
    createAttendance: true, // New field for creating attendance
    createVolunteerOpps: false, // New field for creating volunteer opportunities
    volunteerTypes: [] as string[] // Types of volunteers needed
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (editingEvent) {
      const eventDate = editingEvent.date instanceof Date ? editingEvent.date : (editingEvent.date as any).toDate();
      setFormData({
        title: editingEvent.title,
        description: editingEvent.description,
        date: eventDate.toISOString().split('T')[0],
        time: eventDate.toTimeString().slice(0, 5),
        location: editingEvent.location,
        type: editingEvent.type,
        createAttendance: false, // Don't auto-create for existing events
        createVolunteerOpps: false,
        volunteerTypes: []
      });
    } else {
      const defaultDate = selectedDate || new Date();
      setFormData({
        title: '',
        description: '',
        date: defaultDate.toISOString().split('T')[0],
        time: '10:00',
        location: '',
        type: 'practice',
        createAttendance: true,
        createVolunteerOpps: false,
        volunteerTypes: []
      });
    }
    setErrors({});
  }, [editingEvent, selectedDate, isOpen]);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Event title is required';
    } else if (formData.title.trim().length < 3) {
      newErrors.title = 'Title must be at least 3 characters long';
    }

    if (!formData.date) {
      newErrors.date = 'Date is required';
    } else {
      const selectedDateTime = new Date(`${formData.date}T${formData.time}`);
      const now = new Date();
      if (selectedDateTime < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        newErrors.date = 'Event date cannot be in the past';
      }
    }

    if (!formData.time) {
      newErrors.time = 'Time is required';
    }

    if (!formData.location.trim()) {
      newErrors.location = 'Location is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Function to create related attendance event
  const createAttendanceEvent = async (calendarEvent: any) => {
    try {
      const attendanceEvent = {
        title: calendarEvent.title,
        date: calendarEvent.date,
        type: calendarEvent.type,
        location: calendarEvent.location,
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id // Link to calendar event
      };

      const attendanceEventId = await addDocument('attendance_events', attendanceEvent);
      console.log('Created attendance event:', attendanceEventId);
      return attendanceEventId;
    } catch (error) {
      console.error('Error creating attendance event:', error);
      // Don't fail the main event creation if attendance creation fails
      return null;
    }
  };

  // Function to create volunteer opportunities
  const createVolunteerOpportunities = async (calendarEvent: any) => {
    const volunteerOpps = [];

    if (formData.volunteerTypes.includes('snacks')) {
      volunteerOpps.push({
        title: `Snacks for ${calendarEvent.title}`,
        description: 'Provide snacks and drinks for the team',
        date: calendarEvent.date,
        location: calendarEvent.location,
        type: 'snacks',
        slotsNeeded: 2,
        slotsBooked: [],
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id
      });
    }

    if (formData.volunteerTypes.includes('setup')) {
      volunteerOpps.push({
        title: `Setup for ${calendarEvent.title}`,
        description: 'Help set up equipment and field preparation',
        date: new Date(calendarEvent.date.getTime() - 30 * 60 * 1000), // 30 minutes before
        location: calendarEvent.location,
        type: 'setup',
        slotsNeeded: 3,
        slotsBooked: [],
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id
      });
    }

    if (formData.volunteerTypes.includes('cleanup')) {
      volunteerOpps.push({
        title: `Cleanup after ${calendarEvent.title}`,
        description: 'Help clean up equipment and field after the event',
        date: new Date(calendarEvent.date.getTime() + 2 * 60 * 60 * 1000), // 2 hours after
        location: calendarEvent.location,
        type: 'cleanup',
        slotsNeeded: 2,
        slotsBooked: [],
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id
      });
    }

    // Create all volunteer opportunities
    const createdOpps = [];
    for (const opp of volunteerOpps) {
      try {
        const oppId = await addDocument('volunteer_opportunities', opp);
        createdOpps.push(oppId);
        console.log('Created volunteer opportunity:', oppId);
      } catch (error) {
        console.error('Error creating volunteer opportunity:', error);
      }
    }

    return createdOpps;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm() || !userData) return;

    setIsSubmitting(true);
    try {
      const eventDateTime = new Date(`${formData.date}T${formData.time}`);
      
      const eventData = {
        title: formData.title.trim(),
        description: formData.description.trim(),
        date: eventDateTime,
        location: formData.location.trim(),
        type: formData.type,
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        createdAt: new Date()
      };

      console.log('Saving event data:', eventData);

      let calendarEvent;
      if (editingEvent) {
        console.log('Updating event:', editingEvent.id);
        await updateDocument('events', editingEvent.id, eventData);
        calendarEvent = {
          ...editingEvent,
          ...eventData
        };
      } else {
        console.log('Creating new event');
        const eventId = await addDocument('events', eventData);
        console.log('Event created with ID:', eventId);
        calendarEvent = {
          id: eventId,
          ...eventData
        };

        // Create related events if this is a new event
        if (formData.createAttendance && (formData.type === 'practice' || formData.type === 'game')) {
          await createAttendanceEvent(calendarEvent);
        }

        if (formData.createVolunteerOpps && formData.volunteerTypes.length > 0) {
          await createVolunteerOpportunities(calendarEvent);
        }
      }

      onEventUpdated(calendarEvent);

      // Reset form and close
      setFormData({
        title: '',
        description: '',
        date: '',
        time: '',
        location: '',
        type: 'practice',
        createAttendance: true,
        createVolunteerOpps: false,
        volunteerTypes: []
      });
      onClose();
    } catch (error) {
      console.error('Error saving event:', error);
      setErrors({ submit: 'Failed to save event. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const getEventTypeIcon = (type: string) => {
    switch (type) {
      case 'game': return '⚽';
      case 'practice': return '🏃';
      case 'event': return '📅';
      default: return '📅';
    }
  };

  const getEventTypeColor = (type: string) => {
    switch (type) {
      case 'game': return 'bg-red-100 text-red-800 border-red-200';
      case 'practice': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'event': return 'bg-green-100 text-green-800 border-green-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const handleVolunteerTypeChange = (type: string, checked: boolean) => {
    if (checked) {
      setFormData({
        ...formData,
        volunteerTypes: [...formData.volunteerTypes, type]
      });
    } else {
      setFormData({
        ...formData,
        volunteerTypes: formData.volunteerTypes.filter(t => t !== type)
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-lg w-full max-h-screen overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">
              {editingEvent ? 'Edit Event' : 'Create New Event'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors duration-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Event Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Event Type *
            </label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { value: 'practice', label: 'Practice', icon: '🏃' },
                { value: 'game', label: 'Game', icon: '⚽' },
                { value: 'event', label: 'Event', icon: '📅' }
              ].map(({ value, label, icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFormData({ ...formData, type: value as any })}
                  className={`p-3 border-2 rounded-lg transition-all duration-200 ${
                    formData.type === value
                      ? getEventTypeColor(value)
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="text-2xl mb-1">{icon}</div>
                  <div className="text-sm font-medium">{label}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Event Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Event Title *
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.title ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder={`Enter ${formData.type} title...`}
            />
            {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
          </div>

          {/* Date and Time */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date *
              </label>
              <input
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.date ? 'border-red-500' : 'border-gray-300'
                }`}
              />
              {errors.date && <p className="text-red-500 text-sm mt-1">{errors.date}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Time *
              </label>
              <input
                type="time"
                value={formData.time}
                onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.time ? 'border-red-500' : 'border-gray-300'
                }`}
              />
              {errors.time && <p className="text-red-500 text-sm mt-1">{errors.time}</p>}
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Location *
            </label>
            <input
              type="text"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.location ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter location (e.g., Main Field, Community Center)"
            />
            {errors.location && <p className="text-red-500 text-sm mt-1">{errors.location}</p>}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description (Optional)
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              placeholder="Add any additional details about the event..."
            />
          </div>

          {/* Integration Options (for new events only) */}
          {!editingEvent && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">🔗 Create Related Items</h3>
              
              {/* Attendance Tracking */}
              {(formData.type === 'practice' || formData.type === 'game') && (
                <div className="mb-4">
                  <label className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={formData.createAttendance}
                      onChange={(e) => setFormData({ ...formData, createAttendance: e.target.checked })}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      📋 Create attendance tracking
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 ml-6">
                    Automatically create an attendance event for tracking who attends
                  </p>
                </div>
              )}

              {/* Volunteer Opportunities */}
              <div>
                <label className="flex items-center space-x-2 mb-2">
                  <input
                    type="checkbox"
                    checked={formData.createVolunteerOpps}
                    onChange={(e) => setFormData({ ...formData, createVolunteerOpps: e.target.checked })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    🤝 Create volunteer opportunities
                  </span>
                </label>
                
                {formData.createVolunteerOpps && (
                  <div className="ml-6 space-y-2">
                    <p className="text-xs text-gray-500 mb-2">Select types of volunteers needed:</p>
                    {[
                      { value: 'snacks', label: '🍎 Snacks & Drinks', desc: 'Provide refreshments' },
                      { value: 'setup', label: '⚙️ Setup Help', desc: 'Equipment and field preparation' },
                      { value: 'cleanup', label: '🧹 Cleanup', desc: 'Post-event cleanup' }
                    ].map(({ value, label, desc }) => (
                      <label key={value} className="flex items-start space-x-2">
                        <input
                          type="checkbox"
                          checked={formData.volunteerTypes.includes(value)}
                          onChange={(e) => handleVolunteerTypeChange(value, e.target.checked)}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mt-0.5"
                        />
                        <div>
                          <span className="text-sm text-gray-700">{label}</span>
                          <p className="text-xs text-gray-500">{desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Event Preview */}
          {formData.title && formData.date && formData.time && formData.location && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Preview</h3>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-start space-x-3">
                  <div className="text-2xl">{getEventTypeIcon(formData.type)}</div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-gray-900">{formData.title}</h4>
                    <div className="text-sm text-gray-600 space-y-1 mt-1">
                      <div className="flex items-center space-x-1">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <span>{new Date(`${formData.date}T${formData.time}`).toLocaleDateString()} at {formData.time}</span>
                      </div>
                      <div className="flex items-center space-x-1">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>{formData.location}</span>
                      </div>
                    </div>
                    {formData.description && (
                      <p className="text-sm text-gray-600 mt-2">{formData.description}</p>
                    )}
                    
                    {/* Show what will be created */}
                    {!editingEvent && (formData.createAttendance || formData.createVolunteerOpps) && (
                      <div className="mt-3 pt-2 border-t border-gray-300">
                        <p className="text-xs font-medium text-gray-700 mb-1">Will also create:</p>
                        <ul className="text-xs text-gray-600 space-y-1">
                          {formData.createAttendance && (
                            <li>• Attendance tracking event</li>
                          )}
                          {formData.createVolunteerOpps && formData.volunteerTypes.map(type => (
                            <li key={type}>• {type.charAt(0).toUpperCase() + type.slice(1)} volunteer opportunity</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getEventTypeColor(formData.type)}`}>
                    {formData.type.charAt(0).toUpperCase() + formData.type.slice(1)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-red-600 text-sm">{errors.submit}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex space-x-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-3 px-4 rounded-lg transition duration-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
            >
              {isSubmitting ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              ) : (
                editingEvent ? 'Update Event' : 'Create Event'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EventForm;