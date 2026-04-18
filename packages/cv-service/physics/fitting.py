# packages/cv-service/physics/fitting.py

import numpy as np
from scipy.optimize import curve_fit
from uncertainties import correlated_values, UFloat
from dataclasses import dataclass
from typing import Optional
from .exceptions import FitDivergenceError, InsufficientDataError

@dataclass
class FitResult:
    v0:           UFloat   # ufloat — velocity in m/s with 1-sigma uncertainty
    a:            UFloat   # ufloat — acceleration in m/s² (friction proxy)
    x0:           UFloat   # ufloat — initial position (nuisance parameter)
    chi2_reduced: float    # goodness of fit; expected ~1.0 for good fit
    dof:          int      # degrees of freedom = M - 3
    covariance:   np.ndarray  # float64, shape [3,3] — full pcov from curve_fit

def kinematic_model(t, x0, v0, a):
    return x0 + v0 * t + 0.5 * a * t**2

def fit_velocity_segment(
    t_s: np.ndarray,
    x_m: np.ndarray,
    sigma_x_m: np.ndarray
) -> FitResult:
    """
    Fit the kinematic model x(t) = x0 + v0*t + 0.5*a*t^2 to a window of frames.
    Extracts v0 as a ufloat with correctly propagated covariance uncertainty.
    """
    # 1. Filter out NaNs
    mask = ~np.isnan(x_m)
    t_filtered = t_s[mask]
    x_filtered = x_m[mask]
    sigma_filtered = sigma_x_m[mask]
    
    M = len(t_filtered)
    if M < 4:
        raise InsufficientDataError(f"Segment has only {M} points; need at least 4 for fitting.")
        
    # 2. Centre time array for numerical stability
    t_origin = t_filtered[0]
    t_rel = t_filtered - t_origin
    
    # 3. Initial parameter estimate
    x0_init = x_filtered[0]
    v0_init = (x_filtered[-1] - x_filtered[0]) / (t_rel[-1] - t_rel[0]) if t_rel[-1] != t_rel[0] else 0.0
    a_init  = 0.0
    p0 = [x0_init, v0_init, a_init]
    
    # 4. Perform the fit
    try:
        popt, pcov = curve_fit(
            kinematic_model,
            t_rel,
            x_filtered,
            p0=p0,
            sigma=sigma_filtered,
            absolute_sigma=True,
            method='lm'
        )
    except RuntimeError as e:
        raise FitDivergenceError(f"Curve fit failed to converge: {str(e)}")
        
    if np.any(np.isinf(pcov)):
        raise FitDivergenceError("Singular covariance matrix encountered in fit.")
        
    # 5. Extract results with uncertainty
    x0_u, v0_u, a_u = correlated_values(popt, pcov)
    
    # 6. Diagnostics
    residuals = x_filtered - kinematic_model(t_rel, *popt)
    chi2 = np.sum((residuals / sigma_filtered)**2)
    dof = M - 3
    chi2_reduced = chi2 / dof if dof > 0 else 0.0
    
    return FitResult(
        v0=v0_u,
        a=a_u,
        x0=x0_u,
        chi2_reduced=chi2_reduced,
        dof=dof,
        covariance=pcov
    )
