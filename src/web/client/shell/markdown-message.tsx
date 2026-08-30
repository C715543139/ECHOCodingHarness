import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import styles from './shell.module.css';

function safeMarkdownUrl(url: string): string {
  const safeUrl = defaultUrlTransform(url);
  const scheme = /^[a-z][a-z\d+.-]*:/iu.exec(safeUrl)?.[0].toLowerCase();
  return scheme === undefined || scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:'
    ? safeUrl
    : '';
}

export function MarkdownMessage({ children }: { readonly children: string }) {
  return (
    <div className={styles.markdownBody}>
      <Markdown
        components={{
          a: ({ children: label, href, title }) =>
            href === undefined || href.length === 0 ? (
              <span className={styles.markdownUnsafeLink}>{label}</span>
            ) : (
              <a href={href} rel="noreferrer noopener" target="_blank" title={title}>
                {label}
              </a>
            ),
          img: ({ alt }) => (
            <span className={styles.markdownImagePlaceholder}>[图片：{alt ?? '未命名'}]</span>
          ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {children}
      </Markdown>
    </div>
  );
}
