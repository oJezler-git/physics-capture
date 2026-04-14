# packages/cv-service/physics/fitting.py
import numpy as np
from scipy.optimize import curve_fit
from uncertainties import ufloat, correlated_values
from typing import List, Tuple

def linear_model(t, x0, v0, a):
    return x0 + v0*t + 0.5*a*t**2

def fit_velocity_segment(times: np.ndarray, positions: np.ndarray, uncertainties: np.ndarray) -> ufloat:
    """
    Fits constant velocity (with acceleration) model to segments.
    """
    popt, pcov = curve_fit(linear_model, times, positions, 
                           sigma=uncertainties, absolute_sigma=True)
    
    params = correlated_values(popt, pcov)
    v0 = params[1] # v0 is the second parameter
    return v0
