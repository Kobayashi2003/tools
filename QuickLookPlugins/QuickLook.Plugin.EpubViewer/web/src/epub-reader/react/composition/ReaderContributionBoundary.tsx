import { Component, type ReactNode } from 'react';

interface ReaderContributionBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly resetKey?: unknown;
  readonly resetVersion?: unknown;
}

interface ReaderContributionBoundaryState {
  readonly failed: boolean;
}

/** Contains a contributed React renderer without hiding the Reader viewport. */
export class ReaderContributionBoundary extends Component<
  ReaderContributionBoundaryProps,
  ReaderContributionBoundaryState
> {
  override state: ReaderContributionBoundaryState = { failed: false };

  static getDerivedStateFromError(): ReaderContributionBoundaryState {
    return { failed: true };
  }

  override componentDidUpdate(previous: ReaderContributionBoundaryProps): void {
    if (
      this.state.failed &&
      (previous.resetKey !== this.props.resetKey ||
        previous.resetVersion !== this.props.resetVersion)
    ) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
