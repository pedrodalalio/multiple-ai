import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export function MarkdownBody({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  return (
    <div
      className={cn(
        'prose prose-invert prose-sm max-w-none',
        '[&>*]:my-2 first:[&>*]:mt-0 last:[&>*]:mb-0',
        '[&_p]:leading-relaxed [&_p]:text-foreground/90',
        '[&_strong]:text-foreground [&_strong]:font-semibold',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_code]:font-mono [&_code]:text-primary/90',
        '[&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:overflow-x-auto',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground/90',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
        '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/50 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
        '[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline',
        '[&_hr]:border-border',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ' '}</ReactMarkdown>
      {streaming && <span className="caret" aria-hidden />}
    </div>
  );
}
