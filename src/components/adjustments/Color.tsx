import { useState, useId, useMemo } from 'react';
import { Sliders } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import Slider, { useCompactTrackIndent } from '../ui/Slider';
import ColorWheel from '../ui/ColorWheel';
import { ColorAdjustment, ColorCalibration, HueSatLum, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { Adjustments, ColorGrading } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

type HslTab = 'hue' | 'saturation' | 'luminance' | 'all';

interface ColorPanelProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  appSettings: AppSettings | null;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface ColorSwatchProps {
  color: string;
  isActive: boolean;
  name: string;
  ariaLabel: string;
  onClick: (name: string) => void;
}

const ColorSwatch = ({ color, name, isActive, ariaLabel, onClick }: ColorSwatchProps) => {
  const [isPressed, setIsPressed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseDown = () => {
    setIsPressed(true);
  };

  const handleMouseUp = () => {
    setIsPressed(false);
  };

  const handleMouseLeave = () => {
    setIsPressed(false);
    setIsHovered(false);
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleClick = () => {
    onClick(name);
  };

  const getTransform = () => {
    if (isPressed) return 'scale(0.96)';
    if (isActive) return 'scale(1.1)';
    if (isHovered) return 'scale(1.08)';
    return 'scale(1)';
  };

  return (
    <button
      aria-label={ariaLabel}
      className="relative w-6 h-6 focus:outline-hidden group"
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      onTouchStart={handleMouseDown}
      onTouchEnd={handleMouseUp}
    >
      <div
        className={`absolute inset-0 rounded-full border-2 ${
          isActive ? 'border-white opacity-100' : 'scale-100 border-transparent opacity-0'
        }`}
        style={{
          transform: isActive ? (isPressed ? 'scale(1.1)' : 'scale(1.25)') : undefined,
          transition: `transform ${isPressed ? 100 : 200}ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms ease-out`,
        }}
      />

      <div
        className={`absolute inset-0 rounded-full ${isActive ? 'shadow-lg' : 'shadow-md'}`}
        style={{
          backgroundColor: color,
          transform: getTransform(),
          transition: `transform ${isPressed ? 100 : 200}ms cubic-bezier(0.2, 0, 0, 1), box-shadow 150ms ease-out`,
        }}
      />
    </button>
  );
};

const ColorGradingPanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'3way' | 'global'>('3way');
  const [isExpanded, setIsExpanded] = useState(false);
  const colorGrading = adjustments.colorGrading || INITIAL_ADJUSTMENTS.colorGrading;

  const handleChange = (grading: ColorGrading, newValue: HueSatLum) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorGrading: {
        ...(prev.colorGrading || INITIAL_ADJUSTMENTS.colorGrading),
        [grading]: newValue,
      },
    }));
  };

  const handleColorGradingSliderChange = (grading: ColorGrading, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorGrading: {
        ...(prev.colorGrading || INITIAL_ADJUSTMENTS.colorGrading),
        [grading]: parseFloat(value),
      },
    }));
  };

  const tabs = useMemo(
    () => [
      {
        id: '3way',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="6" r="4.5" />
            <circle cx="5" cy="18" r="4.5" />
            <circle cx="19" cy="18" r="4.5" />
          </svg>
        ),
      },
      {
        id: 'global',
        icon: (
          <div className="w-3.5 h-3.5 rounded-full" style={{ background: 'linear-gradient(to top, #666, #fff)' }} />
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <div className="flex items-center justify-start gap-2 mb-4 mt-2">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as '3way' | 'global')}
              className={`w-7 h-7 rounded-full flex items-center justify-center transition-[color,background-color,box-shadow] focus:outline-none
                ${
                  isActive
                    ? 'ring-2 ring-offset-2 ring-offset-surface ring-accent text-text-primary'
                    : 'bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-secondary/80'
                }`}
            >
              {tab.icon}
            </button>
          );
        })}

        <div className="w-px h-5 bg-text-secondary/20 mx-1" />

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-[color,background-color,box-shadow] focus:outline-none
            ${
              isExpanded
                ? 'bg-accent text-button-text'
                : 'bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-secondary/80'
            }`}
          data-tooltip={t('adjustments.color.toggleSliders')}
        >
          <Sliders size={14} />
        </button>
      </div>

      <div className="relative w-full mb-4">
        <AnimatePresence mode="wait">
          {activeTab === '3way' ? (
            <motion.div
              key="3way"
              initial={{ opacity: 0, x: -15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              transition={{ duration: 0.2 }}
              className="w-full"
            >
              <div className="flex justify-center mb-4">
                <div className="w-[calc(50%-0.5rem)]">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.midtones}
                    label={t('adjustments.color.grading.midtones')}
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Midtones, val)}
                    value={colorGrading.midtones}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
              </div>
              <div className="flex justify-between mb-2 gap-4">
                <div className="w-full flex-1 min-w-0">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.shadows}
                    label={t('adjustments.color.grading.shadows')}
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Shadows, val)}
                    value={colorGrading.shadows}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
                <div className="w-full flex-1 min-w-0">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.highlights}
                    label={t('adjustments.color.grading.highlights')}
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Highlights, val)}
                    value={colorGrading.highlights}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="global"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 15 }}
              transition={{ duration: 0.2 }}
              className="w-full flex justify-center pb-2"
            >
              <div className="w-full">
                <ColorWheel
                  defaultValue={INITIAL_ADJUSTMENTS.colorGrading.global}
                  label={t('adjustments.color.grading.global')}
                  onChange={(val: HueSatLum) => handleChange(ColorGrading.Global, val)}
                  value={colorGrading.global || INITIAL_ADJUSTMENTS.colorGrading.global}
                  onDragStateChange={onDragStateChange}
                  isExpanded={isExpanded}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div>
        <Slider
          defaultValue={50}
          label={t('adjustments.color.grading.blending')}
          max={100}
          min={0}
          onChange={(e: any) => handleColorGradingSliderChange(ColorGrading.Blending, e.target.value)}
          step={1}
          value={colorGrading.blending}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          defaultValue={0}
          label={t('adjustments.color.grading.balance')}
          max={100}
          min={-100}
          onChange={(e: any) => handleColorGradingSliderChange(ColorGrading.Balance, e.target.value)}
          step={1}
          value={colorGrading.balance}
          onDragStateChange={onDragStateChange}
        />
      </div>
    </div>
  );
};

const ColorCalibrationPanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const { t } = useTranslation();
  const [activePrimary, setActivePrimary] = useState('red');
  const labelIndent = useCompactTrackIndent();
  const colorCalibration = adjustments.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration;

  const PRIMARY_COLORS = useMemo(
    () => [
      { name: 'red', color: '#f87171', label: t('adjustments.color.calibration.colors.red') },
      { name: 'green', color: '#4ade80', label: t('adjustments.color.calibration.colors.green') },
      { name: 'blue', color: '#60a5fa', label: t('adjustments.color.calibration.colors.blue') },
    ],
    [t],
  );

  const handleShadowsChange = (value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorCalibration: {
        ...(prev.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration),
        shadowsTint: parseFloat(value),
      },
    }));
  };

  const handlePrimaryChange = (key: 'Hue' | 'Saturation', value: string) => {
    const fullKey = `${activePrimary}${key}` as keyof ColorCalibration;
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorCalibration: {
        ...(prev.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration),
        [fullKey]: parseFloat(value),
      },
    }));
  };

  const currentValues = {
    hue: colorCalibration[`${activePrimary}Hue` as keyof ColorCalibration] || 0,
    saturation: colorCalibration[`${activePrimary}Saturation` as keyof ColorCalibration] || 0,
  };

  const trackSuffix = `${activePrimary}s`;

  return (
    <div className="p-2 bg-bg-tertiary rounded-md mt-4">
      <Text variant={TextVariants.heading} className={`mb-2 ${labelIndent}`}>
        {t('adjustments.color.calibration.title')}
      </Text>
      <div>
        <Text color={TextColors.primary} weight={TextWeights.medium} className={`mb-1 ${labelIndent}`}>
          {t('adjustments.color.calibration.shadows')}
        </Text>
        <Slider
          label={t('adjustments.color.calibration.tint')}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          value={colorCalibration.shadowsTint}
          onChange={(e: any) => handleShadowsChange(e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName="tint-gradient-track"
        />
      </div>
      <div className="mt-3">
        <Text color={TextColors.primary} weight={TextWeights.medium} className={`mb-3 ${labelIndent}`}>
          {t('adjustments.color.calibration.primaries')}
        </Text>
        <div className="flex justify-center gap-6 mb-4 px-1">
          {PRIMARY_COLORS.map(({ name, color, label }) => (
            <ColorSwatch
              color={color}
              isActive={activePrimary === name}
              key={name}
              name={name}
              onClick={setActivePrimary}
              ariaLabel={t('adjustments.color.ariaSelectColor', { name: label })}
            />
          ))}
        </div>
        <Slider
          label={t('adjustments.color.calibration.hue')}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          value={currentValues.hue}
          onChange={(e: any) => handlePrimaryChange('Hue', e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName={`hue-slider-${trackSuffix}`}
        />
        <Slider
          label={t('adjustments.color.calibration.saturation')}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          value={currentValues.saturation}
          onChange={(e: any) => handlePrimaryChange('Saturation', e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName={`sat-slider-${trackSuffix}`}
        />
      </div>
    </div>
  );
};

export default function ColorPanel({
  adjustments,
  setAdjustments,
  appSettings,
  isForMask = false,
  onDragStateChange,
}: ColorPanelProps) {
  const { t } = useTranslation();
  const [hslTab, setHslTab] = useState<HslTab>('hue');
  const hslTabBubbleId = useId();
  const labelIndent = useCompactTrackIndent();
  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};
  const isWgpuEnabled = appSettings?.useWgpuRenderer !== false;

  const HSL_COLORS = useMemo(
    () => [
      { name: 'reds', label: t('adjustments.color.mixerColors.reds') },
      { name: 'oranges', label: t('adjustments.color.mixerColors.oranges') },
      { name: 'yellows', label: t('adjustments.color.mixerColors.yellows') },
      { name: 'greens', label: t('adjustments.color.mixerColors.greens') },
      { name: 'aquas', label: t('adjustments.color.mixerColors.aquas') },
      { name: 'blues', label: t('adjustments.color.mixerColors.blues') },
      { name: 'purples', label: t('adjustments.color.mixerColors.purples') },
      { name: 'magentas', label: t('adjustments.color.mixerColors.magentas') },
    ],
    [t],
  );

  const HSL_PROPERTIES = useMemo(
    () => [
      { key: ColorAdjustment.Hue, tab: 'hue' as HslTab, label: t('adjustments.color.hue'), track: 'hue-slider' },
      {
        key: ColorAdjustment.Saturation,
        tab: 'saturation' as HslTab,
        label: t('adjustments.color.saturation'),
        track: 'sat-slider',
      },
      {
        key: ColorAdjustment.Luminance,
        tab: 'luminance' as HslTab,
        label: t('adjustments.color.luminance'),
        track: 'lum-slider',
      },
    ],
    [t],
  );

  const handleAdjustmentChange = (key: ColorAdjustment, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: parseFloat(value) }));
  };

  const handleHslChange = (color: string, key: ColorAdjustment, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      hsl: {
        ...(prev.hsl || {}),
        [color]: {
          ...(prev.hsl?.[color] || {}),
          [key]: parseFloat(value),
        },
      },
    }));
  };

  const hslTabs: Array<{ id: HslTab; label: string }> = [
    { id: 'hue', label: t('adjustments.color.hue') },
    { id: 'saturation', label: t('adjustments.color.saturation') },
    { id: 'luminance', label: t('adjustments.color.luminance') },
    { id: 'all', label: t('adjustments.color.all') },
  ];

  return (
    <div className="space-y-4">
      <div className="p-1 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-2">
          {isForMask ? t('adjustments.color.localHue') : t('adjustments.color.hue')}
        </Text>
        <Slider
          label={t('adjustments.color.hue')}
          max={180}
          min={-180}
          onChange={(e: any) => handleAdjustmentChange(ColorAdjustment.Hue, e.target.value)}
          step={1}
          value={adjustments.hue || 0}
          trackClassName="hue-range-track"
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-1 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-3">
          {t('adjustments.color.colorGrading')}
        </Text>
        <ColorGradingPanel
          adjustments={adjustments}
          setAdjustments={setAdjustments}
          appSettings={appSettings}
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-1 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-3">
          {t('adjustments.color.colorMixer')}
        </Text>
        <div role="tablist" className="relative flex w-full p-0.5 mb-3 bg-bg-primary rounded-md">
          {hslTabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={hslTab === tab.id}
              onClick={() => setHslTab(tab.id)}
              className={`relative flex-1 px-1 py-1 text-xs font-medium rounded-md transition-colors ${
                hslTab === tab.id ? 'text-button-text' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {hslTab === tab.id && (
                <motion.span
                  layoutId={`hsl-tab-bubble-${hslTabBubbleId}`}
                  className="absolute inset-0 z-0 bg-accent"
                  style={{ borderRadius: 5 }}
                  transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
                />
              )}
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>
        {HSL_PROPERTIES.filter((prop) => hslTab === 'all' || hslTab === prop.tab).map((prop) => (
          <div key={prop.key} className={hslTab === 'all' ? 'mb-3 last:mb-0' : undefined}>
            {hslTab === 'all' && (
              <Text color={TextColors.primary} weight={TextWeights.medium} className={`mb-1 ${labelIndent}`}>
                {prop.label}
              </Text>
            )}
            {HSL_COLORS.map(({ name, label }) => (
              <Slider
                key={name}
                label={label}
                max={100}
                min={-100}
                onChange={(e: any) => handleHslChange(name, prop.key, e.target.value)}
                step={1}
                value={adjustments?.hsl?.[name]?.[prop.key as keyof HueSatLum] ?? 0}
                trackClassName={`${prop.track}-${name}`}
                onDragStateChange={onDragStateChange}
              />
            ))}
          </div>
        ))}
      </div>

      {!isForMask && adjustmentVisibility.colorCalibration !== false && (
        <ColorCalibrationPanel
          adjustments={adjustments}
          setAdjustments={setAdjustments}
          appSettings={appSettings}
          onDragStateChange={onDragStateChange}
        />
      )}
    </div>
  );
}
