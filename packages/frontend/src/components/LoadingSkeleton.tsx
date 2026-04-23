interface LoadingSkeletonProps {
  lines?: number;
  className?: string;
}

export const LoadingSkeleton = ({ lines = 3, className = '' }: LoadingSkeletonProps) => (
  <div className={`space-y-2 ${className}`} aria-hidden="true">
    {Array.from({ length: lines }).map((_, index) => (
      <div
        key={`skeleton-${index}`}
        className="h-3 animate-pulse rounded bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900"
        style={{ width: `${100 - index * 10}%`, animationDelay: `${index * 90}ms` }}
      />
    ))}
  </div>
);
