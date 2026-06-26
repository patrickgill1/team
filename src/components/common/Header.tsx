import React from 'react';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  /** Optional right-aligned action slot (e.g. a "+ Add" button). Kept
   *  flexible so each page can drop its own action in without us
   *  having to know the shape ahead of time. */
  action?: React.ReactNode;
  showUserMenu?: boolean;
}

// Navy "command center" page header — matches the redesigned Events
// page so every screen reads as one app. Replaces the legacy white
// header in one go for every page that imports this. Pages that want
// a different chrome can simply not render <Header />.
const Header: React.FC<HeaderProps> = ({ title = 'GoalKickr', subtitle, action }) => {
  return (
    <header className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 border-b border-brand-primary/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 lg:py-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight truncate">{title}</h1>
          {subtitle && (
            <p className="mt-0.5 text-xs sm:text-sm text-slate-400 truncate">{subtitle}</p>
          )}
        </div>
        {action && (
          <div className="flex-shrink-0">{action}</div>
        )}
      </div>
    </header>
  );
};

export default Header;
