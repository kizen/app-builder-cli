import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode | ((error: Error) => ReactNode);
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfacing via console keeps the devtools panel honest even when the UI
    // is wedged — e.g. a chunk fetch failure after a dev server restart.
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      const { fallback } = this.props;

      return typeof fallback === 'function' ? fallback(this.state.error) : fallback;
    }

    return this.props.children;
  }
}
