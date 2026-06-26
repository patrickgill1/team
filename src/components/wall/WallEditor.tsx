// TipTap-based rich text editor for the Wall composer. Renders a
// dark-themed WYSIWYG with bold/italic, headings, lists, blockquote,
// link, divider, and inline images. Replaces the previous markdown
// textarea — Patrick: "if a person chooses bold, it should just show
// bold. if someone puts in a pic, it should show the pic without
// having to hit view." Output is HTML; posts save with
// contentFormat: 'tiptap-html'.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  // Returns the URL of the uploaded image. Caller handles resize +
  // R2 upload. WallEditor only inserts the resulting URL as an
  // image node at the current cursor.
  uploadImage: (file: File) => Promise<string>;
  onUploadingChange?: (uploading: boolean) => void;
};

export default function WallEditor({ value, onChange, placeholder, uploadImage, onUploadingChange }: Props) {
  // Visible state for the image toolbar button so the user gets
  // immediate feedback during upload (spinner + disabled) and a
  // surfaced error if the upload throws. The previous version only
  // console.error'd, so a failed upload looked like the picker did
  // nothing — Patrick: "i can't upload a photo on in the editor."
  const [imgUploading, setImgUploading] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        codeBlock: false, // prefer inline code only — block code looks like dev output on the wall
      }),
      Image.configure({
        inline: false,
        allowBase64: false,
        HTMLAttributes: { class: 'rounded-xl my-3 max-h-[520px] w-auto' },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: 'text-brand-primary-soft underline underline-offset-2' },
      }),
      Placeholder.configure({
        placeholder: placeholder || 'Share an update with the team…',
        emptyEditorClass: 'is-editor-empty',
      }),
    ],
    content: value || '',
    editorProps: {
      attributes: {
        // Min height so the editor feels like a real composer, not a
        // single-line input. Outer container handles scroll/overflow.
        class: 'tiptap-wall focus:outline-none min-h-[200px] px-4 py-4 text-bone text-[15.5px] leading-relaxed',
      },
      handlePaste(view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) insertImage(file);
            return true;
          }
        }
        return false;
      },
      handleDrop(view, event) {
        const files = (event as DragEvent).dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const file = files[0];
        if (!file.type.startsWith('image/')) return false;
        event.preventDefault();
        insertImage(file);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // Keep editor in sync when parent resets value (e.g., after post).
  // We only refresh when the prop differs from current content to
  // avoid wiping the user's cursor on every onChange round-trip.
  const lastSyncedRef = useRef(value);
  useEffect(() => {
    if (!editor) return;
    if (value === lastSyncedRef.current) return;
    if (value === editor.getHTML()) {
      lastSyncedRef.current = value;
      return;
    }
    editor.commands.setContent(value || '', { emitUpdate: false });
    lastSyncedRef.current = value;
  }, [value, editor]);

  const insertImage = useCallback(async (file: File) => {
    if (!editor) return;
    setImgError(null);
    setImgUploading(true);
    onUploadingChange?.(true);
    try {
      const url = await uploadImage(file);
      if (!url) throw new Error('Upload returned no URL');
      editor.chain().focus().setImage({ src: url }).run();
    } catch (err: any) {
      console.error('[WallEditor] image upload failed', err);
      setImgError(err?.message || 'Image upload failed. Try again.');
    } finally {
      setImgUploading(false);
      onUploadingChange?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, uploadImage, onUploadingChange]);

  const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void insertImage(f);
    e.target.value = '';
  };

  const onAddLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes('link').href;
    const url = window.prompt('Link URL', previous || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  if (!editor) return null;

  return (
    <div className="flex flex-col">
      {/* Toolbar — sticky to the top of the composer scroll area. */}
      <div className="sticky top-0 z-10 bg-charcoal-900 border-b border-white/5 px-2 py-1.5 flex items-center gap-0.5 flex-wrap">
        <ToolGroup>
          <ToolBtn label="H1" active={editor.isActive('heading', { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
          <ToolBtn label="H2" active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        </ToolGroup>
        <ToolGroup>
          <ToolBtn icon={<BoldIcon />} title="Bold" active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolBtn icon={<ItalicIcon />} title="Italic" active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolBtn icon={<StrikeIcon />} title="Strikethrough" active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()} />
        </ToolGroup>
        <ToolGroup>
          <ToolBtn icon={<BulletIcon />} title="Bullet list" active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolBtn icon={<NumberedIcon />} title="Numbered list" active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolBtn icon={<QuoteIcon />} title="Quote" active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <ToolBtn icon={<HrIcon />} title="Divider"
            onClick={() => editor.chain().focus().setHorizontalRule().run()} />
        </ToolGroup>
        <ToolGroup>
          <ToolBtn icon={<LinkIcon />} title="Link" active={editor.isActive('link')} onClick={onAddLink} />
          {/* Image upload — uses a <label>-wrapped <input> so the
              OS file picker opens reliably on iOS WebView. (The
              prior version called fileInputRef.current.click()
              programmatically, which can be silently dropped by
              Capacitor's WebView depending on version.) */}
          <label
            title="Image"
            className={`inline-flex items-center justify-center w-8 h-8 rounded-md transition text-xs font-bold cursor-pointer ${
              imgUploading
                ? 'bg-brand-primary/20 text-brand-primary-soft'
                : 'text-bone/70 hover:bg-white/[0.06] hover:text-bone'
            }`}
          >
            {imgUploading ? <SpinnerIcon /> : <ImageIcon />}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={imgUploading}
              onChange={onFileChosen}
            />
          </label>
        </ToolGroup>
      </div>

      {imgError && (
        <div className="px-4 py-2 text-[12px] text-rose-300 bg-rose-500/10 border-b border-rose-400/20 flex items-center justify-between">
          <span>{imgError}</span>
          <button
            type="button"
            onClick={() => setImgError(null)}
            className="text-bone/60 hover:text-bone text-[11px] font-bold uppercase tracking-widest"
          >
            Dismiss
          </button>
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}

const SpinnerIcon = () => (
  <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" strokeOpacity="0.3" />
    <path strokeLinecap="round" d="M21 12a9 9 0 0 0-9-9" />
  </svg>
);

function ToolGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 px-1 border-r border-white/5 last:border-r-0">
      {children}
    </div>
  );
}

function ToolBtn({ label, icon, title, active, onClick }: {
  label?: string;
  icon?: React.ReactNode;
  title?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-md transition text-xs font-bold ${
        active
          ? 'bg-brand-primary/20 text-brand-primary-soft'
          : 'text-bone/70 hover:bg-white/[0.06] hover:text-bone'
      }`}
    >
      {icon || label}
    </button>
  );
}

const BoldIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M6 4h8a4 4 0 0 1 0 8H6z" />
    <path d="M6 12h9a4 4 0 0 1 0 8H6z" />
  </svg>
);
const ItalicIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="19" y1="4" x2="10" y2="4" />
    <line x1="14" y1="20" x2="5" y2="20" />
    <line x1="15" y1="4" x2="9" y2="20" />
  </svg>
);
const StrikeIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="4" y1="12" x2="20" y2="12" />
    <path d="M17 6a4 4 0 0 0-4-2H11a4 4 0 0 0-4 4M7 18a4 4 0 0 0 4 2h2a4 4 0 0 0 4-4" />
  </svg>
);
const BulletIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="4" cy="6" r="1.5" fill="currentColor" />
    <circle cx="4" cy="12" r="1.5" fill="currentColor" />
    <circle cx="4" cy="18" r="1.5" fill="currentColor" />
  </svg>
);
const NumberedIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="10" y1="6" x2="21" y2="6" />
    <line x1="10" y1="12" x2="21" y2="12" />
    <line x1="10" y1="18" x2="21" y2="18" />
    <path d="M4 6h1v4M4 10h2" />
    <path d="M4 16a1 1 0 1 1 2 0c0 1-2 2-2 4h2" />
  </svg>
);
const QuoteIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M7 7h4v6H7c-1 0-2-1-2-2V9c0-1 1-2 2-2zM15 7h4v6h-4c-1 0-2-1-2-2V9c0-1 1-2 2-2z" />
  </svg>
);
const HrIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="4" y1="12" x2="20" y2="12" />
  </svg>
);
const LinkIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </svg>
);
const ImageIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);
