import { createContext, useContext } from 'react';

/** Width of the dev sidebar in pixels, or 0 when closed. */
export const SidebarContext = createContext(0);
export const useSidebarWidth = (): number => useContext(SidebarContext);
