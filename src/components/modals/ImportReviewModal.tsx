import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, ChevronDown, Folder } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../store/useUIStore';
import { Invokes } from '../../types/invokes';
import Dropdown from '../ui/Dropdown';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface ImportCandidate {
  path: string;
  size: number;
  captured: string; // YYYY-MM-DDTHH:MM:SS, from the modified time until a preview supplies the EXIF date
  duplicate: boolean;
}

interface ImportPreview {
  path: string;
  captured: string;
  thumbnail: string | null;
  orientation: number;
  aspect: number;
}

/** One photo: a raw and its same-named JPEG/HEIC count as a single tile, like Lightroom. */
interface Tile {
  key: string;
  files: ImportCandidate[];
  preview: string;
}

/** A destination folder that will receive photos, with the photos going into it or its subfolders. */
interface FolderNode {
  name: string;
  path: string;
  count: number;
  children: FolderNode[];
}

// Lightroom's numeric "Organize: By date" presets; tokens are resolved by `import_files`.
const DATE_FOLDER_FORMATS = [
  'YYYY/YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYY/MM-DD',
  'YYYY/YYYY-MM',
  'YYYY/MM',
  'YYYY-MM-DD',
  'YYYYMMDD',
];
const FORMAT_KEY = 'importDateFolderFormat';
const DESTINATION_KEY = 'importDestination';
const PREVIEW_BATCH = 24;
const PREVIEW_EXTENSIONS = new Set(['jpg', 'jpeg', 'heic', 'heif', 'hif']);
const ROTATION: Record<number, string> = { 3: 'rotate(180deg)', 6: 'rotate(90deg)', 8: 'rotate(-90deg)' };

/** Last destination confirmed in this dialog, used as the default for card auto-import. */
export function loadSavedDestination(): string | null {
  try {
    return localStorage.getItem(DESTINATION_KEY);
  } catch {
    return null;
  }
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const extension = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
const stripExtension = (p: string) => p.replace(/\.[^.\\/]+$/, '');
const applyDateFormat = (format: string, day: string) => {
  const [y, m, d] = day.split('-');
  return format.replaceAll('YYYY', y).replaceAll('MM', m).replaceAll('DD', d);
};

function loadFormat(): string | null {
  try {
    const saved = localStorage.getItem(FORMAT_KEY);
    if (saved === '') return null;
    if (saved && DATE_FOLDER_FORMATS.includes(saved)) return saved;
  } catch {
    // storage unavailable
  }
  return DATE_FOLDER_FORMATS[0];
}

export default function ImportReviewModal() {
  const { t } = useTranslation();
  const { isOpen, sourcePaths, targetFolder, setUI } = useUIStore(
    useShallow((state) => ({
      isOpen: state.isImportReviewOpen,
      sourcePaths: state.importSourcePaths,
      targetFolder: state.importTargetFolder,
      setUI: state.setUI,
    })),
  );
  const [destination, setDestination] = useState<string | null>(null);
  const [dateFormat, setDateFormat] = useState<string | null>(loadFormat);
  const [lastFormat, setLastFormat] = useState<string>(dateFormat ?? DATE_FOLDER_FORMATS[0]);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, ImportPreview>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [existingFolders, setExistingFolders] = useState<Record<string, boolean>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const lastClickedRef = useRef<number | null>(null);

  useEffect(() => {
    if (isOpen) setDestination(targetFolder);
  }, [isOpen, targetFolder]);

  useEffect(() => {
    setPreviews({});
    setCollapsed(new Set());
  }, [sourcePaths]);

  useEffect(() => {
    if (!isOpen || !destination) return;
    let cancelled = false;
    setCandidates(null);
    invoke<ImportCandidate[]>(Invokes.GetImportCandidates, { sourcePaths, destinationFolder: destination })
      .then((result) => {
        if (cancelled) return;
        setCandidates(result);
        setSelected(new Set(result.filter((c) => !c.duplicate).map((c) => c.path)));
      })
      .catch((err) => console.error('Failed to check import candidates:', err));
    return () => {
      cancelled = true;
    };
  }, [isOpen, destination, sourcePaths]);

  const tiles = useMemo(() => {
    const byStem = new Map<string, ImportCandidate[]>();
    for (const c of candidates ?? []) {
      const stem = stripExtension(c.path);
      byStem.set(stem, [...(byStem.get(stem) ?? []), c]);
    }
    return Array.from(byStem, ([key, files]): Tile => {
      const preview = files.find((f) => PREVIEW_EXTENSIONS.has(extension(f.path))) ?? files[0];
      return { key, files, preview: preview.path };
    });
  }, [candidates]);

  // Thumbnails and EXIF dates stream in batches, in display order.
  useEffect(() => {
    if (!isOpen || tiles.length === 0) return;
    let cancelled = false;
    (async () => {
      const pending = tiles.map((tile) => tile.preview).filter((p) => !previewsRef.current[p]);
      for (let i = 0; i < pending.length && !cancelled; i += PREVIEW_BATCH) {
        const batch = await invoke<ImportPreview[]>(Invokes.ReadImportPreviews, {
          paths: pending.slice(i, i + PREVIEW_BATCH),
        }).catch(() => []);
        if (cancelled) return;
        setPreviews((prev) => {
          const next = { ...prev };
          for (const p of batch) next[p.path] = p;
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, tiles]);

  const groups = useMemo(() => {
    const byDay = new Map<string, Tile[]>();
    const capturedOf = (tile: Tile) => previews[tile.preview]?.captured ?? tile.files[0].captured;
    for (const tile of [...tiles].sort((a, b) => capturedOf(a).localeCompare(capturedOf(b)))) {
      const day = capturedOf(tile).slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), tile]);
    }
    return Array.from(byDay, ([day, dayTiles]) => ({ day, tiles: dayTiles }));
  }, [tiles, previews]);
  // Shift-click ranges only span tiles that are on screen.
  const orderedTiles = useMemo(
    () => groups.filter((g) => !collapsed.has(g.day)).flatMap((g) => g.tiles),
    [groups, collapsed],
  );

  // Every destination folder that will receive a selected photo, as a tree with photo counts.
  const folderTree = useMemo(() => {
    const roots: FolderNode[] = [];
    if (!dateFormat) return roots;
    const byPath = new Map<string, FolderNode>();
    for (const { day, tiles: dayTiles } of groups) {
      const count = dayTiles.filter((tile) => tile.files.some((f) => selected.has(f.path))).length;
      if (count === 0) continue;
      let siblings = roots;
      let prefix = '';
      for (const name of applyDateFormat(dateFormat, day).split('/')) {
        prefix = prefix ? `${prefix}/${name}` : name;
        let node = byPath.get(prefix);
        if (!node) {
          node = { name, path: prefix, count: 0, children: [] };
          byPath.set(prefix, node);
          siblings.push(node);
        }
        node.count += count;
        siblings = node.children;
      }
    }
    return roots;
  }, [dateFormat, groups, selected]);

  const folderKey = useMemo(() => {
    const paths: string[] = [];
    const collect = (nodes: FolderNode[]) => nodes.forEach((n) => (paths.push(n.path), collect(n.children)));
    collect(folderTree);
    return paths.join('\n');
  }, [folderTree]);

  useEffect(() => {
    setExistingFolders({});
    if (!isOpen || !destination || !folderKey) return;
    let cancelled = false;
    const relative = folderKey.split('\n');
    invoke<boolean[]>(Invokes.CheckImportFolders, { base: destination, relative })
      .then((exists) => {
        if (!cancelled) setExistingFolders(Object.fromEntries(relative.map((p, i) => [p, exists[i]])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, destination, folderKey]);

  if (!isOpen) return null;
  const close = () => setUI({ isImportReviewOpen: false });
  const isTileSelected = (tile: Tile) => tile.files.some((f) => selected.has(f.path));
  const isTileDuplicate = (tile: Tile) => tile.files.every((f) => f.duplicate);
  const selectedTiles = tiles.filter(isTileSelected).length;
  const duplicateTiles = tiles.filter(isTileDuplicate).length;

  const setTiles = (targets: Tile[], checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      targets.flatMap((tile) => tile.files).forEach((f) => (checked ? next.add(f.path) : next.delete(f.path)));
      return next;
    });

  const handleTileClick = (index: number, shiftKey: boolean) => {
    const checked = !isTileSelected(orderedTiles[index]);
    const anchor = lastClickedRef.current;
    if (shiftKey && anchor !== null) {
      setTiles(orderedTiles.slice(Math.min(anchor, index), Math.max(anchor, index) + 1), checked);
    } else {
      setTiles([orderedTiles[index]], checked);
    }
    lastClickedRef.current = index;
  };

  const toggleCollapsed = (day: string) => {
    lastClickedRef.current = null;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const renderFolder = (node: FolderNode, depth: number): ReactNode => (
    <div key={node.path}>
      <div className="flex items-center gap-2 py-1 text-sm" style={{ paddingLeft: depth * 14 }}>
        <Folder className="shrink-0 text-text-secondary" size={14} />
        <span className="truncate flex-1 text-text-primary">{node.name}</span>
        {existingFolders[node.path] === false && (
          <span className="text-[10px] px-1 rounded bg-accent text-button-text">
            {t('modals.importReview.newFolder')}
          </span>
        )}
        <span className="text-text-secondary text-xs tabular-nums">{node.count}</span>
      </div>
      {node.children.map((child) => renderFolder(child, depth + 1))}
    </div>
  );

  const changeFormat = (format: string | null) => {
    setDateFormat(format);
    if (format) setLastFormat(format);
    try {
      localStorage.setItem(FORMAT_KEY, format ?? '');
    } catch {
      // storage unavailable
    }
  };

  const chooseDestination = async () => {
    const dir = await open({ directory: true, defaultPath: destination ?? undefined });
    if (typeof dir === 'string') setDestination(dir);
  };

  const handleContinue = () => {
    if (!destination || !candidates || selected.size === 0) return;
    try {
      localStorage.setItem(DESTINATION_KEY, destination);
    } catch {
      // storage unavailable
    }
    setUI({
      isImportReviewOpen: false,
      importSourcePaths: candidates.filter((c) => selected.has(c.path)).map((c) => c.path),
      importTargetFolder: destination,
      importDateFolderFormat: dateFormat,
      isImportModalOpen: true,
    });
  };

  const today = new Date().toISOString().slice(0, 10);
  const secondaryButton =
    'px-2 py-1 bg-bg-primary text-text-secondary rounded-md hover:bg-card-active transition-colors';
  let tileIndex = 0;

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs"
      onClick={close}
      onKeyDown={(e) => e.key === 'Escape' && close()}
      role="dialog"
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-[96vw] max-w-[1800px] h-[92vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 min-w-0 flex flex-col p-6">
          <div className="flex items-end justify-between gap-4 mb-3">
            <div>
              <Text variant={TextVariants.title} className="mb-1">
                {t('modals.importReview.title')}
              </Text>
              <Text variant={TextVariants.small}>
                {candidates
                  ? `${t('modals.importReview.selectedCount', { selected: selectedTiles, total: tiles.length })}${
                      duplicateTiles > 0
                        ? ` · ${t('modals.importReview.duplicateCount', { duplicates: duplicateTiles })}`
                        : ''
                    }`
                  : t('modals.importReview.checking')}
              </Text>
            </div>
            <div className="flex gap-2 text-xs">
              <button className={secondaryButton} onClick={() => setTiles(tiles, true)}>
                {t('modals.importReview.selectAll')}
              </button>
              <button
                className={secondaryButton}
                onClick={() => {
                  setSelected(new Set());
                  setTiles(
                    tiles.filter((tile) => !isTileDuplicate(tile)),
                    true,
                  );
                }}
              >
                {t('modals.importReview.selectNew')}
              </button>
              <button className={secondaryButton} onClick={() => setSelected(new Set())}>
                {t('modals.importReview.selectNone')}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto bg-bg-primary rounded-md min-h-0">
            {groups.map(({ day, tiles: dayTiles }) => {
              const count = dayTiles.filter(isTileSelected).length;
              const isCollapsed = collapsed.has(day);
              return (
                <section key={day}>
                  <div
                    className="sticky top-0 z-10 flex items-center gap-3 px-3 py-2 bg-card-active cursor-pointer text-sm select-none"
                    onClick={() => toggleCollapsed(day)}
                  >
                    <button
                      aria-expanded={!isCollapsed}
                      className="text-text-secondary hover:text-text-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(day);
                      }}
                      type="button"
                    >
                      <ChevronDown className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} size={16} />
                    </button>
                    <input
                      checked={count === dayTiles.length}
                      className="accent-accent"
                      onChange={(e) => setTiles(dayTiles, e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                      ref={(el) => {
                        if (el) el.indeterminate = count > 0 && count < dayTiles.length;
                      }}
                      type="checkbox"
                    />
                    <span className="text-text-primary font-medium">
                      {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' })}
                    </span>
                    <span className="text-text-secondary text-xs tabular-nums">
                      {count}/{dayTiles.length}
                    </span>
                    {dateFormat && (
                      <span className="ml-auto truncate text-text-secondary text-xs font-mono">
                        {destination && `${basename(destination)}/`}
                        {applyDateFormat(dateFormat, day)}
                      </span>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div
                      className="grid gap-3 p-3"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
                    >
                      {dayTiles.map((tile) => {
                        const index = tileIndex++;
                        const isSelected = isTileSelected(tile);
                        const isDuplicate = isTileDuplicate(tile);
                        const preview = previews[tile.preview];
                        const captured = preview?.captured ?? tile.files[0].captured;
                        return (
                          <button
                            className={`relative text-left rounded-md overflow-hidden bg-surface transition-opacity ${
                              isSelected ? 'ring-2 ring-accent' : 'opacity-50 hover:opacity-80'
                            } ${isDuplicate ? 'grayscale' : ''}`}
                            key={tile.key}
                            onClick={(e) => handleTileClick(index, e.shiftKey)}
                            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 180px' }}
                            type="button"
                          >
                            <div className="aspect-square w-full flex items-center justify-center overflow-hidden bg-black/30">
                              {preview?.thumbnail ? (
                                // Crop the thumbnail's 4:3 padding to the real ratio, then rotate the cropped box.
                                <div
                                  style={{
                                    aspectRatio: preview.aspect,
                                    transform: ROTATION[preview.orientation],
                                    width: preview.aspect >= 1 ? '100%' : `${preview.aspect * 100}%`,
                                  }}
                                >
                                  <img
                                    alt=""
                                    className="w-full h-full object-cover"
                                    draggable={false}
                                    src={preview.thumbnail}
                                  />
                                </div>
                              ) : (
                                <span className="text-text-secondary text-xs uppercase">{extension(tile.preview)}</span>
                              )}
                            </div>
                            <span
                              className={`absolute top-1.5 left-1.5 w-4 h-4 rounded-sm border flex items-center justify-center ${
                                isSelected ? 'bg-accent border-accent' : 'bg-black/40 border-white/60'
                              }`}
                            >
                              {isSelected && <Check className="text-button-text" size={12} strokeWidth={3} />}
                            </span>
                            {isDuplicate && (
                              <span className="absolute top-1.5 right-1.5 text-[10px] px-1 rounded bg-black/70 text-white">
                                {t('modals.importReview.alreadyImported')}
                              </span>
                            )}
                            <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-text-secondary">
                              <span className="truncate flex-1">{basename(tile.key)}</span>
                              <span className="uppercase">{tile.files.map((f) => extension(f.path)).join('+')}</span>
                              <span className="tabular-nums">{captured.slice(11, 16)}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>

        <aside className="w-80 shrink-0 border-l border-border-color p-6 flex flex-col gap-5">
          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importReview.destination')}
            </Text>
            <div className="bg-bg-primary rounded-md p-2 text-sm text-text-primary break-all mb-2">{destination}</div>
            <button
              className="w-full px-3 py-2 rounded-md bg-bg-primary text-text-secondary hover:bg-card-active transition-colors text-sm"
              onClick={chooseDestination}
            >
              {t('modals.importReview.choose')}
            </button>
          </div>

          <div className="space-y-3">
            <Text variant={TextVariants.heading} className="block">
              {t('modals.importSettings.folderOrganization')}
            </Text>
            <Switch
              checked={dateFormat !== null}
              label={t('modals.importSettings.organizeByDate')}
              onChange={(on) => changeFormat(on ? lastFormat : null)}
            />
            {dateFormat && (
              <div>
                <Text variant={TextVariants.label} className="block mb-1">
                  {t('modals.importSettings.dateFormat')}
                </Text>
                <Dropdown
                  onChange={changeFormat}
                  options={DATE_FOLDER_FORMATS.map((f) => ({ label: applyDateFormat(f, today), value: f }))}
                  value={dateFormat}
                />
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importReview.folderPreview')}
            </Text>
            <div className="flex-1 overflow-y-auto bg-bg-primary rounded-md p-2">
              <div className="flex items-center gap-2 py-1 text-sm">
                <Folder className="shrink-0 text-text-secondary" size={14} />
                <span className="truncate flex-1 text-text-primary">{destination && basename(destination)}</span>
                <span className="text-text-secondary text-xs tabular-nums">{selectedTiles}</span>
              </div>
              {folderTree.map((node) => renderFolder(node, 1))}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-bg-primary transition-colors"
              onClick={close}
            >
              {t('modals.importSettings.cancel')}
            </button>
            <button
              className="px-4 py-2 rounded-md bg-accent shadow-shiny text-button-text font-semibold hover:bg-accent-hover transition-colors disabled:opacity-50"
              disabled={!destination || !candidates || selected.size === 0}
              onClick={handleContinue}
            >
              {t('modals.importReview.continue')}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
