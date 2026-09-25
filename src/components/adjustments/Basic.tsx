import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Pipette } from 'lucide-react';
import Slider, { useCompactTrackIndent } from '../ui/Slider';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { Adjustments, BasicAdjustment, ColorAdjustment, DetailsAdjustment } from '../../utils/adjustments';
import { useTranslation } from 'react-i18next';

interface BasicAdjustmentsProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  isForMask?: boolean;
  isWbPickerActive?: boolean;
  toggleWbPicker?: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
  appSettings?: any;
}

interface ToneMapperSwitchProps {
  selectedMapper: string;
  onMapperChange: (mapper: string) => void;
}

const Divider = () => <div className="my-2 border-t border-border-color/60" />;

// Light-to-dark track, as Lightroom uses for Contrast and the Presence sliders.
const INVERTED = 'tone-gradient-track-inverted';

// Two-value switch: "Basic" on the left, "AgX" on the right.
const ToneMapperSwitch = ({ selectedMapper, onMapperChange }: ToneMapperSwitchProps) => {
  const { t } = useTranslation();
  const isAgx = selectedMapper === 'agx';

  const option = (id: string, label: string, title: string) => (
    <button
      type="button"
      data-tooltip={title}
      onClick={() => onMapperChange(id)}
      className={clsx(
        'text-xs font-medium transition-colors',
        selectedMapper === id ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
      {option('basic', t('adjustments.basic.mappers.basic'), t('adjustments.basic.mappers.basicDesc'))}
      <button
        type="button"
        role="switch"
        aria-checked={isAgx}
        aria-label={t('adjustments.basic.toneMapper')}
        onClick={() => onMapperChange(isAgx ? 'basic' : 'agx')}
        className="relative w-7 h-4 rounded-full bg-card-active"
      >
        <motion.span
          className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-accent"
          initial={false}
          animate={{ x: isAgx ? 12 : 0 }}
          transition={{ type: 'spring', stiffness: 700, damping: 30 }}
        />
      </button>
      {option('agx', t('adjustments.basic.mappers.agx'), t('adjustments.basic.mappers.agxDesc'))}
    </div>
  );
};

export default function BasicAdjustments({
  adjustments,
  setAdjustments,
  isForMask = false,
  isWbPickerActive = false,
  toggleWbPicker,
  onDragStateChange,
  appSettings,
}: BasicAdjustmentsProps) {
  const { t } = useTranslation();

  const handleAdjustmentChange = (key: string, value: any) => {
    const numericValue = parseFloat(value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleToneMapperChange = (mapper: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      toneMapper: mapper as 'basic' | 'agx',
    }));
  };

  const hideTonemapper = isForMask || appSettings?.tonemapperOverrideEnabled;
  const headingIndent = useCompactTrackIndent();
  const showPresenceDetails = appSettings?.adjustmentVisibility?.presence !== false;

  const slider = (
    key: string,
    label: string,
    opts: { min?: number; max?: number; step?: number; track?: string } = {},
  ) => (
    <Slider
      label={label}
      max={opts.max ?? 100}
      min={opts.min ?? -100}
      onChange={(e: any) => handleAdjustmentChange(key, e.target.value)}
      step={opts.step ?? 1}
      value={(adjustments as any)[key] ?? 0}
      trackClassName={opts.track ?? 'tone-gradient-track'}
      onDragStateChange={onDragStateChange}
    />
  );

  return (
    <div className="space-y-4">
      <div className="p-1 bg-bg-tertiary rounded-md">
        <div className="flex justify-between items-center mb-2">
          <Text variant={TextVariants.heading} className={headingIndent}>
            {t('adjustments.color.whiteBalance')}
          </Text>
          {!isForMask && toggleWbPicker && (
            <button
              onClick={toggleWbPicker}
              className={`p-1.5 rounded-md transition-colors ${
                isWbPickerActive ? 'bg-accent text-button-text' : 'hover:bg-bg-secondary text-text-secondary'
              }`}
              data-tooltip={t('adjustments.color.wbPickerTooltip')}
            >
              <Pipette size={16} />
            </button>
          )}
        </div>
        <Slider
          label={t('adjustments.color.temperature')}
          max={100}
          min={-100}
          onChange={(e: any) => handleAdjustmentChange(ColorAdjustment.Temperature, e.target.value)}
          step={1}
          value={adjustments.temperature || 0}
          trackClassName="temperature-gradient-track"
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label={t('adjustments.color.tint')}
          max={100}
          min={-100}
          onChange={(e: any) => handleAdjustmentChange(ColorAdjustment.Tint, e.target.value)}
          step={1}
          value={adjustments.tint || 0}
          trackClassName="tint-gradient-track"
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-1 bg-bg-tertiary rounded-md">
        <div className="flex justify-between items-center mb-2">
          <Text variant={TextVariants.heading} className={headingIndent}>
            {t('adjustments.basic.tone')}
          </Text>
          {!hideTonemapper && (
            <ToneMapperSwitch
              selectedMapper={adjustments.toneMapper || 'agx'}
              onMapperChange={handleToneMapperChange}
            />
          )}
        </div>
        {slider(BasicAdjustment.Exposure, t('adjustments.basic.exposure'), { min: -5, max: 5, step: 0.01 })}
        {slider(BasicAdjustment.Contrast, t('adjustments.basic.contrast'), { track: INVERTED })}
        <Divider />
        {slider(BasicAdjustment.Highlights, t('adjustments.basic.highlights'))}
        {slider(BasicAdjustment.Shadows, t('adjustments.basic.shadows'))}
        {slider(BasicAdjustment.Whites, t('adjustments.basic.whites'))}
        {slider(BasicAdjustment.Blacks, t('adjustments.basic.blacks'))}
        {slider(BasicAdjustment.Brightness, t('adjustments.basic.brightness'), { min: -5, max: 5, step: 0.01 })}
      </div>

      <div className="p-1 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className={`mb-2 ${headingIndent}`}>
          {t('adjustments.details.presence')}
        </Text>
        {showPresenceDetails && (
          <>
            {slider(DetailsAdjustment.Structure, t('adjustments.details.structure'), { track: INVERTED })}
            {slider(DetailsAdjustment.Clarity, t('adjustments.details.clarity'), { track: INVERTED })}
            {slider(DetailsAdjustment.Dehaze, t('adjustments.details.dehaze'), { track: INVERTED })}
            {!isForMask && slider(DetailsAdjustment.Centré, t('adjustments.details.centre'), { track: INVERTED })}
            <Divider />
          </>
        )}
        {slider(ColorAdjustment.Vibrance, t('adjustments.color.vibrance'), { track: 'saturation-gradient-track' })}
        {slider(ColorAdjustment.Saturation, t('adjustments.color.saturation'), { track: 'saturation-gradient-track' })}
      </div>
    </div>
  );
}
