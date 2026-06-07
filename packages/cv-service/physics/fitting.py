# packages/cv-service/physics/fitting.py

import numpy as np
from scipy.optimize import curve_fit
from uncertainties import correlated_values, UFloat, ufloat
from dataclasses import dataclass
from typing import Optional
from .exceptions import FitDivergenceError, InsufficientDataError

@dataclass(frozen=True)
class FitResult:
    v0:           UFloat   # ufloat — velocity in m/s with 1-sigma uncertainty
    a:            UFloat   # ufloat — acceleration in m/s² (friction proxy)
    x0:           UFloat   # ufloat — initial position (nuisance parameter)
    chi2_reduced: float    # goodness of fit; expected ~1.0 for good fit
    dof:          int      # degrees of freedom
    covariance:   np.ndarray  # float64, shape [3,3] — full pcov from curve_fit

def kinematic_model(t, x0, v0, a):
    return x0 + v0 * t + 0.5 * a * t**2

def _create_fit_result(t_rel, x_filtered, sigma_filtered, popt, pcov, M, is_linear):
    dof = M - 2 if is_linear else M - 3
    x0_u, v0_u, a_u = correlated_values(popt, pcov)
    residuals = x_filtered - kinematic_model(t_rel, *popt)
    chi2 = np.sum((residuals / sigma_filtered)**2)
    return FitResult(
        v0=v0_u, a=a_u, x0=x0_u,
        chi2_reduced=chi2 / dof if dof > 0 else 0.0,
        dof=dof, covariance=pcov
    )

def _fit_linear(t, x, s):
    def linear_model(t, x0, v0): return x0 + v0 * t
    p0 = [x[0], (x[-1]-x[0])/(t[-1]-t[0]) if t[-1]>t[0] else 0]
    popt, pcov = curve_fit(linear_model, t, x, p0=p0, sigma=s, absolute_sigma=True)
    return [popt[0], popt[1], 0.0], np.pad(pcov, ((0,1),(0,1)))

def _fit_parabolic(t, x, s):
    p0 = [x[0], (x[-1]-x[0])/(t[-1]-t[0]) if t[-1]>t[0] else 0, 0.0]
    popt, pcov = curve_fit(kinematic_model, t, x, p0=p0, sigma=s, absolute_sigma=True, method='lm')
    if np.any(np.isinf(pcov)): raise FitDivergenceError("Singular matrix")
    return popt, pcov

def fit_velocity_segment(
    t_s: np.ndarray,
    x_m: np.ndarray,
    sigma_x_m: np.ndarray
) -> FitResult:
    mask = ~np.isnan(x_m)
    t_filtered, x_filtered, sigma_filtered = t_s[mask], x_m[mask], sigma_x_m[mask]
    
    M = len(t_filtered)
    if M < 4:
        raise InsufficientDataError(f"Segment has only {M} points; need at least 4 for fitting.")
        
    t_rel = t_filtered - t_filtered[0]
    
    # 3. Fit
    if M < 30:
        popt, pcov = _fit_linear(t_rel, x_filtered, sigma_filtered)
        res = _create_fit_result(t_rel, x_filtered, sigma_filtered, popt, pcov, M, True)
    else:
        try:
            popt, pcov = _fit_parabolic(t_rel, x_filtered, sigma_filtered)
        except (FitDivergenceError, RuntimeError, ValueError):
            popt, pcov = _fit_linear(t_rel, x_filtered, sigma_filtered)
            res = _create_fit_result(t_rel, x_filtered, sigma_filtered, popt, pcov, M, True)
        else:
            res = _create_fit_result(t_rel, x_filtered, sigma_filtered, popt, pcov, M, False)
            
    # 4. Acceleration Damping
    if abs(res.a.nominal_value) > 0.15:
        damping = 0.15 / abs(res.a.nominal_value)
        return FitResult(
            v0=res.v0, x0=res.x0, chi2_reduced=res.chi2_reduced, dof=res.dof, covariance=res.covariance,
            a=ufloat(res.a.nominal_value * damping, res.a.std_dev)
        )
    return res
