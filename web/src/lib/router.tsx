import { useEffect, useState } from 'react';

/** A tiny client-side router: enough for a handful of top-level pages. */

const NAVIGATE_EVENT = 'almanac:navigate';

export function navigate(to: string, { replace = false } = {}): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** The current location, updated on navigation and back/forward. */
export function useLocation(): { pathname: string; search: string } {
  const read = () => ({ pathname: location.pathname, search: location.search });
  const [current, setCurrent] = useState(read);

  useEffect(() => {
    const update = () => setCurrent(read());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);

  return current;
}

export function Link({
  to,
  children,
  ...props
}: { to: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a
      href={to}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        // Let the browser handle new-tab clicks and modified clicks.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        navigate(to);
        window.scrollTo(0, 0);
      }}
    >
      {children}
    </a>
  );
}
