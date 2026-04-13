import React from 'react';
import { Play, Pause, ChevronLeft, ChevronRight } from 'lucide-react';

interface FrameScrubberProps {
  currentFrame: number;
  frameCount: number;
  onFrameChange: (frame: number) => void;
  isPlaying?: boolean;
  onPlayToggle?: () => void;
}

export const FrameScrubber: React.FC<FrameScrubberProps> = ({
  currentFrame,
  frameCount,
  onFrameChange,
  isPlaying,
  onPlayToggle,
}) => {
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFrameChange(parseInt(e.target.value, 10));
  };

  const incrementFrame = () => {
    if (currentFrame < frameCount - 1) onFrameChange(currentFrame + 1);
  };

  const decrementFrame = () => {
    if (currentFrame > 0) onFrameChange(currentFrame - 1);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl flex flex-col gap-4">
      <div className="flex items-center gap-4">
        {/* Play/Pause Button */}
        {onPlayToggle && (
          <button
            onClick={onPlayToggle}
            className="w-10 h-10 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 rounded-full transition-colors shadow-lg"
          >
            {isPlaying ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" className="ml-0.5" />}
          </button>
        )}

        {/* Step Controls */}
        <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700">
          <button
            onClick={decrementFrame}
            className="p-2 hover:bg-slate-700 rounded-md transition-colors text-slate-400 hover:text-white"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="px-4 font-mono text-sm font-bold text-indigo-400 min-w-[100px] text-center">
            {currentFrame + 1} / {frameCount}
          </div>
          <button
            onClick={incrementFrame}
            className="p-2 hover:bg-slate-700 rounded-md transition-colors text-slate-400 hover:text-white"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        {/* Slider Scrubber */}
        <div className="flex-1 px-4 relative group">
          <input
            type="range"
            min="0"
            max={Math.max(0, frameCount - 1)}
            value={currentFrame}
            onChange={handleSliderChange}
            className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400 transition-all"
          />
          {/* Visual indicator for current frame could go here */}
        </div>
      </div>
      
      {/* Keyboard Hint */}
      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold flex justify-center gap-6">
        <span>Space: Play/Pause</span>
        <span>←/→: Step Frames</span>
      </div>
    </div>
  );
};
