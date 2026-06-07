# packages/cv-service/tests/physics/test_momentum.py

import pytest
from uncertainties import ufloat
from physics.momentum import compute_physics

def test_cor_sign_2_balls_normal_separation():
    # Ball 0 hit Ball 1. Ball 1 was at rest.
    # After hit, Ball 1 is faster than Ball 0.
    masses = [ufloat(0.1, 0.001), ufloat(0.1, 0.001)]
    v_before = [ufloat(1.0, 0.01), ufloat(0.0, 0.0)]
    v_after = [ufloat(0.2, 0.01), ufloat(0.8, 0.01)]
    
    results = compute_physics(masses, v_before, v_after)
    # e = (0.8 - 0.2) / (1.0 - 0.0) = 0.6
    assert results.cor.nominal_value == pytest.approx(0.6)

def test_cor_sign_2_balls_striker_faster_after_impact():
    # This is the "problematic" case reported by the user.
    # Ball 0: 0.151 -> 0.105
    # Ball 1: 0.0 -> 0.032
    masses = [ufloat(0.05, 0.001), ufloat(0.05, 0.001)]
    v_before = [ufloat(0.151, 0.001), ufloat(0.0, 0.0)]
    v_after = [ufloat(0.105, 0.001), ufloat(0.032, 0.001)]
    
    results = compute_physics(masses, v_before, v_after)
    
    # We now expect it to be positive (using absolute values of relative velocities)
    # e = |0.032 - 0.105| / |0.151 - 0| = 0.073 / 0.151 = 0.483...
    assert results.cor.nominal_value > 0
    assert results.cor.nominal_value == pytest.approx(0.073 / 0.151)
    
def test_cor_sign_1_ball_no_rebound():
    # Case where ball slows down but doesn't bounce back (e.g. hitting soft obstacle)
    masses = [ufloat(0.1, 0.001)]
    v_before = [ufloat(1.0, 0.01)]
    v_after = [ufloat(0.5, 0.01)]
    
    results = compute_physics(masses, v_before, v_after)
    # Should be positive 0.5
    assert results.cor.nominal_value == pytest.approx(0.5)
