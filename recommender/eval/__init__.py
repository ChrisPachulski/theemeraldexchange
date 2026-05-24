# Eval package — holds the holdout generator + holdout schema docs.
# Empty __init__.py makes `python -m eval.build_holdout` work as a
# regular package under all interpreter configurations (PEP 420
# namespace packages would also resolve, but a real package avoids
# the edge case where /srv is shadowed by another `eval` on sys.path).
