# packages/cv-service/physics/momentum.py

from dataclasses import dataclass
from typing import List, Literal
from uncertainties import UFloat

@dataclass
class PhysicsOutput:
    # Per ball
    p_before_per_ball:  List[UFloat]   # kg·m/s
    p_after_per_ball:   List[UFloat]   # kg·m/s
    ke_before_per_ball: List[UFloat]   # Joules
    ke_after_per_ball:  List[UFloat]   # Joules
    # System totals
    p_before_total:     UFloat
    p_after_total:      UFloat
    ke_before_total:    UFloat
    ke_after_total:     UFloat
    # Derived
    conservation_pct:   UFloat         # (p_after/p_before - 1) * 100
    cor:                UFloat         # coefficient of restitution

def compute_physics(
    masses_kg: List[UFloat],
    v_before: List[UFloat],
    v_after: List[UFloat],
    ke_mode: Literal["rolling_sphere", "point_mass"] = "rolling_sphere"
) -> PhysicsOutput:
    """
    Given ufloat velocities and ufloat masses, compute all physics quantities.
    The uncertainties library propagates all uncertainty automatically.
    """
    ke_factor = 0.7 if ke_mode == "rolling_sphere" else 0.5
    
    p_before_per_ball = []
    p_after_per_ball = []
    ke_before_per_ball = []
    ke_after_per_ball = []
    
    for m, vb, va in zip(masses_kg, v_before, v_after):
        p_before_per_ball.append(m * vb)
        p_after_per_ball.append(m * va)
        ke_before_per_ball.append(ke_factor * m * vb**2)
        ke_after_per_ball.append(ke_factor * m * va**2)
        
    p_before_total = sum(p_before_per_ball)
    p_after_total  = sum(p_after_per_ball)
    ke_before_total = sum(ke_before_per_ball)
    ke_after_total  = sum(ke_after_per_ball)
    
    # % momentum conserved
    if p_before_total.nominal_value != 0:
        conservation_pct = (p_after_total / p_before_total - 1.0) * 100.0
    else:
        conservation_pct = None
        
    # Coefficient of restitution
    cor = None
    if len(masses_kg) == 2:
        # e = |v2_after - v1_after| / |v1_before - v2_before|
        # Use magnitudes so the reported coefficient is always non-negative.
        rel_v_before = v_before[0] - v_before[1]
        rel_v_after = v_after[1] - v_after[0]
        if rel_v_before.nominal_value != 0:
            cor = abs(rel_v_after / rel_v_before)
    elif len(masses_kg) == 1:
        # Wall collision
        if v_before[0].nominal_value != 0:
            cor = abs(v_after[0] / v_before[0])
            
    return PhysicsOutput(
        p_before_per_ball=p_before_per_ball,
        p_after_per_ball=p_after_per_ball,
        ke_before_per_ball=ke_before_per_ball,
        ke_after_per_ball=ke_after_per_ball,
        p_before_total=p_before_total,
        p_after_total=p_after_total,
        ke_before_total=ke_before_total,
        ke_after_total=ke_after_total,
        conservation_pct=conservation_pct,
        cor=cor
    )
