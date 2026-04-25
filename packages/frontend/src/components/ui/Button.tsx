import React from 'react';
import { sounds } from '../../lib/sounds';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'main' | 'alt' | 'none';
  sound?: keyof typeof sounds;
  hoverSound?: keyof typeof sounds;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className = '',
  variant = 'none',
  sound = 'click',
  hoverSound = 'hover',
  onClick,
  onMouseEnter,
  disabled,
  ...props
}) => {
  const getVariantClass = () => {
    switch (variant) {
      case 'main':
        return 'btn-main';
      case 'alt':
        return 'btn-alt';
      default:
        return '';
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!disabled) {
      sounds[sound]?.();
    }
    onClick?.(e);
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!disabled && hoverSound) {
      sounds[hoverSound]?.();
    }
    onMouseEnter?.(e);
  };

  return (
    <button
      {...props}
      disabled={disabled}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      className={`${getVariantClass()} ${className}`}
    >
      {children}
    </button>
  );
};
