import json
import logging
import os

import lightgbm as lgb
import onnxmltools
import pandas as pd
from onnxmltools.convert.lightgbm.operator_converters.LightGbm import convert_lightgbm
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import KFold, train_test_split
from skl2onnx import update_registered_converter
from skl2onnx.common.data_types import FloatTensorType
from skl2onnx.common.shape_calculator import calculate_linear_regressor_output_shapes

from model_config import (
    FEATURE_COLUMNS,
    GENDERS,
    MIN_TRAINING_SAMPLES,
    MODEL_CONFIG,
    MODEL_CONFIG_PATH,
    MODEL_MANIFEST,
    MODELS_DIR,
    PROFILE_DATA_PATH,
    RATIO_BOUNDS,
    STROKES,
    TARGET_TYPE,
    clean_profile_frame,
    compute_feature_medians,
    prepare_training_data,
    source_column_for_stroke,
    target_column_for_stroke,
    training_data_report,
)

lgb_logger = logging.getLogger("lightgbm")
lgb_logger.setLevel(logging.WARNING)

update_registered_converter(
    lgb.LGBMRegressor,
    "LightGbmLGBMRegressor",
    calculate_linear_regressor_output_shapes,
    convert_lightgbm,
    options={"split": None},
)


def evaluate_model(feature_frame, target_series, source_series):
    model = lgb.LGBMRegressor(**MODEL_CONFIG)
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    maes = []
    r2s = []

    for train_idx, test_idx in kf.split(feature_frame):
        model.fit(feature_frame.iloc[train_idx], target_series.iloc[train_idx])
        predicted = model.predict(feature_frame.iloc[test_idx])

        if TARGET_TYPE == "ratio":
            predicted_50m = predicted * source_series.iloc[test_idx]
            actual_50m = target_series.iloc[test_idx] * source_series.iloc[test_idx]
        else:
            predicted_50m = predicted
            actual_50m = target_series.iloc[test_idx]

        maes.append(mean_absolute_error(actual_50m, predicted_50m))
        r2s.append(r2_score(actual_50m, predicted_50m))

    return {
        "cv_mae_seconds": round(float(sum(maes) / len(maes)), 3),
        "cv_r2": round(float(sum(r2s) / len(r2s)), 3),
    }


def create_all_models():
    print("Loading swimmer profile data...")
    os.makedirs(MODELS_DIR, exist_ok=True)

    with open(PROFILE_DATA_PATH, "r", encoding="utf-8") as profile_file:
        all_profiles = json.load(profile_file)

    training_manifest = {
        **MODEL_MANIFEST,
        "models": {},
    }

    for gender in GENDERS:
        print(f"\n{'=' * 60}\nProcessing models for: {gender.upper()}\n{'=' * 60}")
        df = pd.DataFrame(all_profiles[gender])
        clean_df = clean_profile_frame(df)
        gender_medians = compute_feature_medians(clean_df)

        report = training_data_report(df)
        print("Data quality:")
        for stroke, stats in report.items():
            print(
                f"  {stroke}: {stats['valid_age_up_pairs']} valid pairs "
                f"({stats['rejected']} rejected, {stats['with_both_distances']} with both distances)"
            )

        medians_file = os.path.join(MODELS_DIR, f"{gender}-medians.json")
        with open(medians_file, "w", encoding="utf-8") as medians_output:
            json.dump(gender_medians.to_dict(), medians_output)
        print(f"Saved {gender} medians to: {medians_file}")

        for stroke in STROKES:
            print(f"\n--- Training {stroke.title()} model for {gender.title()} ---")

            feature_frame, target_series, source_series, dropped_rows = prepare_training_data(
                df, stroke, gender_medians
            )
            if len(feature_frame) < MIN_TRAINING_SAMPLES:
                print(
                    f"Not enough data to train {stroke} model for {gender} "
                    f"({len(feature_frame)} < {MIN_TRAINING_SAMPLES}). Skipping."
                )
                continue

            print(
                f"Training on {len(feature_frame)} samples "
                f"({dropped_rows} rows rejected by ratio bounds {RATIO_BOUNDS})"
            )

            metrics = evaluate_model(feature_frame, target_series, source_series)
            print(
                f"Cross-validated 50m error: MAE={metrics['cv_mae_seconds']}s, "
                f"R2={metrics['cv_r2']}"
            )

            train_features, holdout_features, train_target, holdout_target = train_test_split(
                feature_frame,
                target_series,
                test_size=0.2,
                random_state=42,
            )

            model = lgb.LGBMRegressor(**MODEL_CONFIG)
            model.fit(
                train_features,
                train_target,
                eval_set=[(holdout_features, holdout_target)],
                eval_metric="mae",
                callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=0)],
            )

            print("Retraining with full dataset...")
            final_model = lgb.LGBMRegressor(**MODEL_CONFIG)
            final_model.fit(feature_frame, target_series)

            print("Converting to ONNX...")
            initial_type = [("float_input", FloatTensorType([None, len(FEATURE_COLUMNS)]))]
            onnx_model = onnxmltools.convert_lightgbm(final_model, initial_types=initial_type)

            model_path = os.path.join(MODELS_DIR, f"{stroke}-{gender}-model.onnx")
            with open(model_path, "wb") as model_output:
                model_output.write(onnx_model.SerializeToString())
            print(f"Model saved to: {model_path}")

            training_manifest["models"][f"{stroke}-{gender}"] = {
                "samples": len(feature_frame),
                "source_feature": source_column_for_stroke(stroke),
                "target_feature": target_column_for_stroke(stroke),
                **metrics,
            }

    manifest_path = os.path.join(MODELS_DIR, "training-manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as manifest_output:
        json.dump(training_manifest, manifest_output, indent=2)
    print(f"\nTraining manifest saved to: {manifest_path}")


if __name__ == "__main__":
    create_all_models()
