import numpy as np

def _tps_kernel(r2):
    return np.where(r2 < 1e-12, 0.0, r2 * np.log(np.maximum(r2, 1e-12)))

def solve_unscaled(r_val):
    K = _tps_kernel(np.array([r_val**2]))
    print(f"r={r_val}, K={K}, ratio={0.08 / K}")

solve_unscaled(50.0)
solve_unscaled(1.0)
