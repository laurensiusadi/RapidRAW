import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../store/useUIStore';
import { Invokes } from '../ui/AppProperties';
import Dropdown from '../ui/Dropdown';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface ImportCandidate {
  path: string;
  size: number;
  captured: string; // YYYY-MM-DDTHH:MM:SS
  duplicate: boolean;
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

/** Last destination confirmed in this dialog, used as the default for card auto-import. */
export function loadSavedDestination(): string | null {
  try {
    return localStorage.getItem(DESTINATION_KEY);
  } catch {
    return null;
  }
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
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
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isOpen) setDestination(targetFolder);
  }, [isOpen, targetFolder]);

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

  const groups = useMemo(() => {
    const byDay = new Map<string, ImportCandidate[]>();
    for (const c of candidates ?? []) {
      const day = c.captured.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), c]);
    }
    return Array.from(byDay, ([day, files]) => ({ day, files }));
  }, [candidates]);

  if (!isOpen) return null;
  const close = () => setUI({ isImportReviewOpen: false });
  const duplicateCount = candidates?.filter((c) => c.duplicate).length ?? 0;
  const today = new Date().toISOString().slice(0, 10);

  const setPaths = (paths: string[], checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => (checked ? next.add(p) : next.delete(p)));
      return next;
    });

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

  const secondaryButton =
    'px-2 py-1 bg-bg-primary text-text-secondary rounded-md hover:bg-card-active transition-colors';

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs"
      onClick={close}
      onKeyDown={(e) => e.key === 'Escape' && close()}
      role="dialog"
    >
      <div
        className="bg-surface rounded-lg shadow-xl p-6 w-full max-w-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <Text variant={TextVariants.title} className="mb-1">
          {t('modals.importReview.title')}
        </Text>
        <Text variant={TextVariants.small} className="mb-4">
          {candidates
            ? `${t('modals.importReview.selectedCount', { selected: selected.size, total: candidates.length })}${
                duplicateCount > 0
                  ? ` · ${t('modals.importReview.duplicateCount', { duplicates: duplicateCount })}`
                  : ''
              }`
            : t('modals.importReview.checking')}
        </Text>

        <div className="flex gap-2 mb-2 text-xs">
          <button
            className={secondaryButton}
            onClick={() => candidates && setSelected(new Set(candidates.map((c) => c.path)))}
          >
            {t('modals.importReview.selectAll')}
          </button>
          <button
            className={secondaryButton}
            onClick={() =>
              candidates && setSelected(new Set(candidates.filter((c) => !c.duplicate).map((c) => c.path)))
            }
          >
            {t('modals.importReview.selectNew')}
          </button>
          <button className={secondaryButton} onClick={() => setSelected(new Set())}>
            {t('modals.importReview.selectNone')}
          </button>
        </div>

        {/* ponytail: plain list, no thumbnails; the thumbnail queue is shared with the library grid */}
        <div className="flex-1 overflow-y-auto bg-bg-primary rounded-md text-sm min-h-0">
          {groups.map(({ day, files }) => {
            const paths = files.map((f) => f.path);
            const count = paths.filter((p) => selected.has(p)).length;
            return (
              <div key={day}>
                <label className="sticky top-0 z-10 flex items-center gap-3 px-3 py-2 bg-card-active cursor-pointer">
                  <input
                    checked={count === paths.length}
                    className="accent-accent"
                    onChange={(e) => setPaths(paths, e.target.checked)}
                    ref={(el) => {
                      if (el) el.indeterminate = count > 0 && count < paths.length;
                    }}
                    type="checkbox"
                  />
                  <span className="text-text-primary font-medium">
                    {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' })}
                  </span>
                  <span className="text-text-secondary text-xs tabular-nums">
                    {count}/{paths.length}
                  </span>
                  {dateFormat && (
                    <span className="ml-auto truncate text-text-secondary text-xs font-mono">
                      {destination && `${basename(destination)}/`}
                      {applyDateFormat(dateFormat, day)}
                    </span>
                  )}
                </label>
                {files.map((file) => (
                  <label
                    className={`flex items-center gap-3 pl-9 pr-3 py-1.5 hover:bg-card-active cursor-pointer ${
                      file.duplicate ? 'opacity-40' : ''
                    }`}
                    key={file.path}
                  >
                    <input
                      checked={selected.has(file.path)}
                      className="accent-accent"
                      onChange={(e) => setPaths([file.path], e.target.checked)}
                      type="checkbox"
                    />
                    <span className="flex-1 truncate text-text-primary">{basename(file.path)}</span>
                    {file.duplicate && (
                      <span className="text-text-secondary text-xs">{t('modals.importReview.alreadyImported')}</span>
                    )}
                    <span className="text-text-secondary text-xs tabular-nums">{file.captured.slice(11, 16)}</span>
                    <span className="text-text-secondary text-xs tabular-nums w-16 text-right">
                      {(file.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importReview.destination')}
            </Text>
            <div className="flex gap-2 items-center">
              <span className="flex-1 truncate bg-bg-primary rounded-md p-2 text-sm text-text-primary">
                {destination}
              </span>
              <button
                className="px-3 py-2 rounded-md bg-bg-primary text-text-secondary hover:bg-card-active transition-colors text-sm"
                onClick={chooseDestination}
              >
                {t('modals.importReview.choose')}
              </button>
            </div>
          </div>
          <Text variant={TextVariants.heading} className="block">
            {t('modals.importSettings.folderOrganization')}
          </Text>
          <Switch
            checked={dateFormat !== null}
            label={t('modals.importSettings.organizeByDate')}
            onChange={(on) => changeFormat(on ? lastFormat : null)}
          />
          {dateFormat && (
            <div className="flex items-center gap-3">
              <Text variant={TextVariants.label}>{t('modals.importSettings.dateFormat')}</Text>
              <Dropdown
                className="flex-1"
                onChange={changeFormat}
                options={DATE_FOLDER_FORMATS.map((f) => ({ label: applyDateFormat(f, today), value: f }))}
                value={dateFormat}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
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
      </div>
    </div>
  );
}
