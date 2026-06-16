// Single source of truth for the user-facing app version. Bump these
// on every release alongside ios/App.xcodeproj/project.pbxproj
// (MARKETING_VERSION + CURRENT_PROJECT_VERSION) and
// android/app/build.gradle (versionName + versionCode).
//
// Surfaced in Settings → About so a parent reporting a bug can tell
// us which version they're on. Also a good anchor for the
// "what's new" modal — match the modal's "since" check against this.

export const APP_VERSION = '3.0.1';
export const APP_BUILD = '21';
