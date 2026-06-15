import json
import os

import numpy as np
import pandas as pd


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PREDICTION_DIR = os.path.dirname(__file__)
PROFILE_DATA_PATH = os.path.join(ROOT_DIR, "public", "files", "swimmer-profiles.json")
MODELS_DIR = os.path.join(PREDICTION_DIR, "models")
MODEL_CONFIG_PATH = os.path.join(PREDICTION_DIR, "model-config.json")

with open(MODEL_CONFIG_PATH, "r", encoding="utf-8") as config_file:
    MODEL_MANIFEST = json.load(config_file)

GENDERS = ["boys", "girls"]
STROKES = ["free", "back", "breast", "fly"]
RATIO_BOUNDS = tuple(MODEL_MANIFEST["ratio_bounds"])
FEATURE_COLUMNS = MODEL_MANIFEST["feature_columns"]
TARGET_TYPE = MODEL_MANIFEST["target_type"]
MIN_TRAINING_SAMPLES = MODEL_MANIFEST["min_training_samples"]

MODEL_CONFIG = {
    "n_estimators": 300,
    "learning_rate": 0.05,
    "max_depth": 4,
    "min_child_samples": 15,
    "reg_alpha": 0.2,
    "reg_lambda": 0.5,
    "subsample": 0.85,
    "colsample_bytree": 0.9,
    "random_state": 42,
    "n_jobs": -1,
    "verbosity": -1,
}


def source_column_for_stroke(stroke):
    return f"{stroke}_25m_best"


def target_column_for_stroke(stroke):
    return f"{stroke}_50m_best"


def clean_profile_frame(df):
    """Normalize sentinel values and numeric types before training."""
    clean_df = df.copy()

    expected_columns = set(FEATURE_COLUMNS)
    expected_columns.update(target_column_for_stroke(stroke) for stroke in STROKES)

    for column in expected_columns:
        if column not in clean_df.columns:
            clean_df[column] = -1
        clean_df[column] = pd.to_numeric(clean_df[column], errors="coerce")

    clean_df[FEATURE_COLUMNS] = clean_df[FEATURE_COLUMNS].replace(-1, np.nan)
    for stroke in STROKES:
        target_column = target_column_for_stroke(stroke)
        clean_df[target_column] = clean_df[target_column].replace(-1, np.nan)

    return clean_df


def compute_feature_medians(clean_df):
    medians = clean_df[FEATURE_COLUMNS].median()
    return medians.fillna(0)


def is_valid_age_up_pair(source_time, target_time, bounds=RATIO_BOUNDS):
    if pd.isna(source_time) or pd.isna(target_time):
        return False
    if source_time <= 0 or target_time <= 0:
        return False

    ratio = target_time / source_time
    low_ratio, high_ratio = bounds
    return low_ratio <= ratio <= high_ratio


def prepare_training_data(raw_df, stroke, medians):
    clean_df = clean_profile_frame(raw_df)
    target_column = target_column_for_stroke(stroke)
    source_column = source_column_for_stroke(stroke)

    valid_rows = clean_df.apply(
        lambda row: is_valid_age_up_pair(row[source_column], row[target_column]),
        axis=1,
    )

    trainable_df = clean_df.loc[valid_rows].copy()
    feature_frame = trainable_df[FEATURE_COLUMNS].fillna(medians)
    target_series = trainable_df[target_column]
    source_series = trainable_df[source_column]

    if TARGET_TYPE == "ratio":
        target_series = target_series / source_series

    dropped_rows = int((~valid_rows).sum())
    return feature_frame, target_series, source_series, dropped_rows


def training_data_report(raw_df):
    clean_df = clean_profile_frame(raw_df)
    report = {}

    for stroke in STROKES:
        source_column = source_column_for_stroke(stroke)
        target_column = target_column_for_stroke(stroke)
        has_both = clean_df[source_column].notna() & clean_df[target_column].notna()
        valid = clean_df.apply(
            lambda row: is_valid_age_up_pair(row[source_column], row[target_column]),
            axis=1,
        )
        report[stroke] = {
            "profiles": len(clean_df),
            "with_both_distances": int(has_both.sum()),
            "valid_age_up_pairs": int(valid.sum()),
            "rejected": int(has_both.sum() - valid.sum()),
        }

    return report
