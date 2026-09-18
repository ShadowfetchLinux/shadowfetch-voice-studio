import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface Props {
  children: ReactNode;
  /** Changing this key resets the boundary (e.g. the current page). */
  resetKey?: unknown;
}
interface State {
  error: Error | null;
}

/** Catches render errors of a page so the shell (sidebar, header, toasts) keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("page crashed", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-[640px] mx-auto mt-12 panel p-6 flex flex-col gap-4" role="alert">
        <div className="flex items-center gap-3 text-danger">
          <AlertTriangle className="size-6" />
          <h2>This page hit an error</h2>
        </div>
        <pre className="text-[12.5px] whitespace-pre-wrap break-words bg-panel-alt rounded-[var(--radius-control)] p-3 max-h-64 overflow-auto">{this.state.error.message}</pre>
        <div>
          <Button variant="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
