# packages/cv-service/physics/exceptions.py

class PhysicsError(Exception):
    """Base class for all physics module exceptions."""
    pass

class InsufficientDataError(PhysicsError):
    """Raised when there is not enough track data to perform fitting."""
    pass

class FitDivergenceError(PhysicsError):
    """Raised when the curve fit fails to converge or produces singular covariance."""
    pass

class InsufficientWindowError(PhysicsError):
    """Raised when a collision window is too small to perform fitting."""
    pass
