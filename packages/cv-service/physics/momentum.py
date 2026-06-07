# packages/cv-service/physics/momentum.py

from dataclasses import dataclass
from typing import List, Literal, Optional, Tuple
from uncertainties import UFloat, ufloat
from uncertainties.umath import sqrt as usqrt

@dataclass
class PhysicsOutput:
    # Per ball
    p_before_per_ball:  List[UFloat]   # kg·m/s (magnitude)
    p_after_per_ball:   List[UFloat]   # kg·m/s (magnitude)
    ke_before_per_ball: List[UFloat]   # Joules
    ke_after_per_ball:  List[UFloat]   # Joules
    # System totals
    p_before_total:     UFloat         # Magnitude of vector sum
    p_after_total:      UFloat         # Magnitude of vector sum
    ke_before_total:    UFloat
    ke_after_total:     UFloat
    # Derived
    conservation_pct:   UFloat         # (p_after/p_before - 1) * 100
    cor:                UFloat         # coefficient of restitution

def compute_physics_2d(
    masses_kg: List[UFloat],
    v_before: List[Tuple[UFloat, UFloat]], # (vx, vy)
    v_after: List[Tuple[UFloat, UFloat]],
    positions_at_collision: Optional[List[Tuple[float, float]]] = None,
    ke_mode: Literal["rolling_sphere", "point_mass"] = "rolling_sphere"
) -> PhysicsOutput:
    """
    Compute physics for 2D planar motion using vector momentum.
    """
    ke_factor = 0.7 if ke_mode == "rolling_sphere" else 0.5
    
    p_before_per_ball = []
    p_after_per_ball = []
    ke_before_per_ball = []
    ke_after_per_ball = []
    
    # Vector sums for system momentum
    sys_px_before = ufloat(0, 0)
    sys_py_before = ufloat(0, 0)
    sys_px_after = ufloat(0, 0)
    sys_py_after = ufloat(0, 0)
    
    for m, vb, va in zip(masses_kg, v_before, v_after):
        vbx, vby = vb
        vax, vay = va
        
        # Magnitudes for per-ball output
        vb_mag = usqrt(vbx**2 + vby**2)
        va_mag = usqrt(vax**2 + vay**2)
        
        p_before_per_ball.append(m * vb_mag)
        p_after_per_ball.append(m * va_mag)
        ke_before_per_ball.append(ke_factor * m * vb_mag**2)
        ke_after_per_ball.append(ke_factor * m * va_mag**2)
        
        # Accumulate vector components
        sys_px_before += m * vbx
        sys_py_before += m * vby
        sys_px_after += m * vax
        sys_py_after += m * vay
        
    p_before_total = usqrt(sys_px_before**2 + sys_py_before**2)
    p_after_total  = usqrt(sys_px_after**2 + sys_py_after**2)
    ke_before_total = sum(ke_before_per_ball)
    ke_after_total  = sum(ke_after_per_ball)
    
    # % momentum conserved
    conservation_pct = None
    if p_before_total.nominal_value != 0:
        conservation_pct = (p_after_total / p_before_total - 1.0) * 100.0
        
    # Coefficient of restitution (CoR)
    cor = None
    if len(masses_kg) == 2:
        # Define relative velocities
        # v_rel = v1 - v2
        rvx_pre = v_before[0][0] - v_before[1][0]
        rvy_pre = v_before[0][1] - v_before[1][1]
        # v_rel_post = v1' - v2'
        rvx_post = v_after[0][0] - v_after[1][0]
        rvy_post = v_after[0][1] - v_after[1][1]

        # Use Magnitude-based CoR for 2D Planar Stability
        rel_v_before = usqrt(rvx_pre**2 + rvy_pre**2)
        rel_v_after = usqrt(rvx_post**2 + rvy_post**2)
        
        if rel_v_before.nominal_value > 0.001:
            cor = rel_v_after / rel_v_before

    elif len(masses_kg) == 1:
        # Wall collision
        vb_mag = usqrt(v_before[0][0]**2 + v_before[0][1]**2)
        va_mag = usqrt(v_after[0][0]**2 + v_after[0][1]**2)
        if vb_mag.nominal_value != 0:
            cor = va_mag / vb_mag
            
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

def compute_physics(
    masses_kg: List[UFloat],
    v_before: List[UFloat],
    v_after: List[UFloat],
    ke_mode: Literal["rolling_sphere", "point_mass"] = "rolling_sphere"
) -> PhysicsOutput:
    """Backward compatibility for 1D scalar inputs."""
    v_before_2d = [(v, ufloat(0, 0)) for v in v_before]
    v_after_2d = [(v, ufloat(0, 0)) for v in v_after]
    return compute_physics_2d(masses_kg, v_before_2d, v_after_2d, ke_mode)
