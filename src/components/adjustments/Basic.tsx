import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Pipette } from 'lucide-react';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { Adjustments, BasicAdjustment, ColorAdjustment, DetailsAdjustment } from '../../utils/adjustments';
import { useEffect, useRef, useState, useMemo } from 'react';
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

const ToneMapperSwitch = ({ selectedMapper, onMapperChange }: ToneMapperSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const toneMapperOptions = useMemo(
    () => [
      {
        id: 'basic',
        label: t('adjustments.basic.mappers.basic'),
        title: t('adjustments.basic.mappers.basicDesc'),
      },
      {
        id: 'agx',
        label: t('adjustments.basic.mappers.agx'),
        title: t('adjustments.basic.mappers.agxDesc'),
      },
    ],
    [t],
  );

  const handleReset = () => onMapperChange('basic');

  useEffect(() => {
    const selectedIndex = toneMapperOptions.findIndex((m) => m.id === selectedMapper);
    const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const widthPercent = 100 / toneMapperOptions.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      let initialX;
      if (selectedMapper === 'agx') {
        initialX = `${toneMapperOptions.length * 100}%`;
      } else {
        initialX = '-25%';
      }

      setBubbleStyle({
        x: [initialX, targetX],
        width: targetWidth,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [selectedMapper, toneMapperOptions]);

  return (
    <div className="group mb-3">
      <div className="flex justify-between items-center mb-2">
        <div
          className="grid cursor-pointer"
          onClick={handleReset}
          onDoubleClick={handleReset}
          onMouseEnter={() => setIsLabelHovered(true)}
          onMouseLeave={() => setIsLabelHovered(false)}
        >
          <span
            aria-hidden={isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
              isLabelHovered ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {t('adjustments.basic.toneMapper')}
          </span>
          <span
            aria-hidden={!isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
              isLabelHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {t('adjustments.basic.reset')}
          </span>
        </div>
      </div>
      <div className="relative flex w-full p-1 bg-card-active rounded-md">
        <div className="relative flex w-full">
          <motion.div
            className="absolute top-0 bottom-0 z-0 bg-accent"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
          {toneMapperOptions.map((mapper) => (
            <button
              key={mapper.id}
              data-tooltip={mapper.title}
              onClick={() => onMapperChange(mapper.id)}
              className={clsx(
                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors',
                {
                  'text-text-primary hover:bg-surface': selectedMapper !== mapper.id,
                  'text-button-text': selectedMapper === mapper.id,
                },
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <span className="relative z-10 flex items-center">{mapper.label}</span>
            </button>
          ))}
        </div>
      </div>
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
  const showPresenceDetails = appSettings?.adjustmentVisibility?.presence !== false;

  const slider = (key: string, label: string, opts: { min?: number; max?: number; step?: number } = {}) => (
    <Slider
      label={label}
      max={opts.max ?? 100}
      min={opts.min ?? -100}
      onChange={(e: any) => handleAdjustmentChange(key, e.target.value)}
      step={opts.step ?? 1}
      value={(adjustments as any)[key] ?? 0}
      onDragStateChange={onDragStateChange}
    />
  );

  return (
    <div className="space-y-4">
      <div className="p-1 bg-bg-tertiary rounded-md">
        <div className="flex justify-between items-center mb-2">
          <Text variant={TextVariants.heading}>{t('adjustments.color.whiteBalance')}</Text>
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
        <Text variant={TextVariants.heading} className="mb-2">
          {t('adjustments.basic.tone')}
        </Text>
        {!hideTonemapper && (
          <ToneMapperSwitch selectedMapper={adjustments.toneMapper || 'agx'} onMapperChange={handleToneMapperChange} />
        )}
        {slider(BasicAdjustment.Exposure, t('adjustments.basic.exposure'), { min: -5, max: 5, step: 0.01 })}
        {slider(BasicAdjustment.Contrast, t('adjustments.basic.contrast'))}
        <Divider />
        {slider(BasicAdjustment.Highlights, t('adjustments.basic.highlights'))}
        {slider(BasicAdjustment.Shadows, t('adjustments.basic.shadows'))}
        {slider(BasicAdjustment.Whites, t('adjustments.basic.whites'))}
        {slider(BasicAdjustment.Blacks, t('adjustments.basic.blacks'))}
        {slider(BasicAdjustment.Brightness, t('adjustments.basic.brightness'), { min: -5, max: 5, step: 0.01 })}
      </div>

      <div className="p-1 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-2">
          {t('adjustments.details.presence')}
        </Text>
        {showPresenceDetails && (
          <>
            {slider(DetailsAdjustment.Structure, t('adjustments.details.structure'))}
            {slider(DetailsAdjustment.Clarity, t('adjustments.details.clarity'))}
            {slider(DetailsAdjustment.Dehaze, t('adjustments.details.dehaze'))}
            {!isForMask && slider(DetailsAdjustment.Centré, t('adjustments.details.centre'))}
            <Divider />
          </>
        )}
        {slider(ColorAdjustment.Vibrance, t('adjustments.color.vibrance'))}
        {slider(ColorAdjustment.Saturation, t('adjustments.color.saturation'))}
      </div>
    </div>
  );
}
