'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

const VARIANT = {
  primary: 'bg-white text-black hover:bg-neutral-200',
  secondary: 'bg-ink-3 text-white hover:bg-ink-4',
  ghost: 'text-neutral-300 hover:bg-ink-3 hover:text-white',
} as const;

export function Button({ variant = 'primary', size = 'md', className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANT; size?: 'sm' | 'md' | 'lg' }) {
  const pad = size === 'lg' ? 'px-6 py-3 text-base' : size === 'sm' ? 'px-3 py-2 text-sm' : 'px-3 py-2 text-base';
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition duration-300 ease-soft
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:scale-[0.98]
        disabled:pointer-events-none disabled:opacity-40 ${pad} ${VARIANT[variant]} ${className}`}
    />
  );
}

export function Panel({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rise rounded-2xl border border-ink-4 bg-ink-1 p-6 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-ink-3 ${className}`} />;
}
