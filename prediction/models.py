import pandas as pd
import numpy as np
import os
import json
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score, mean_absolute_error
import onnxmltools
from skl2onnx.common.data_types import FloatTensorType
import logging

# Disable LightGBM warnings
lgb_logger = logging.getLogger('lightgbm')
lgb_logger.setLevel(logging.WARNING)

# Register LightGBM converter for ONNX
from skl2onnx import update_registered_converter
from skl2onnx.common.shape_calculator import calculate_linear_regressor_output_shapes
from onnxmltools.convert.lightgbm.operator_converters.LightGbm import convert_lightgbm

update_registered_converter(
    lgb.LGBMRegressor,
    'LightGbmLGBMRegressor',
    calculate_linear_regressor_output_shapes,
    convert_lightgbm,
    options={'split': None}
)

def create_all_models():
    print("🐍 Loading swimmer profile data...")
    try:
        script_dir = os.path.dirname(__file__)
        file_path = os.path.join(script_dir, "..", "files", "swimmer-profiles.json")
        models_dir = os.path.join(script_dir, "models")
        os.makedirs(models_dir, exist_ok=True)
    except NameError:
        script_dir = os.getcwd()
        file_path = os.path.join(script_dir, "..", "files", "swimmer-profiles.json")
        models_dir = os.path.join(script_dir, "models")
        os.makedirs(models_dir, exist_ok=True)

    with open(file_path, 'r') as f:
        all_profiles = json.load(f)

    # Optimized model configuration
    MODEL_CONFIG = {
        "n_estimators": 150,
        "learning_rate": 0.1,
        "max_depth": 5,
        "random_state": 42,
        "n_jobs": -1,
        "verbosity": -1  # Additional silencing for LightGBM
    }

    genders = ["boys", "girls"]
    strokes_to_predict = ["free", "back", "breast", "fly"]
    feature_columns = [
        "free_25m_best", "free_25m_avg", "free_25m_std", "free_25m_count",
        "back_25m_best", "back_25m_avg", "back_25m_std", "back_25m_count",
        "breast_25m_best", "breast_25m_avg", "breast_25m_std", "breast_25m_count",
        "fly_25m_best", "fly_25m_avg", "fly_25m_std", "fly_25m_count"
    ]

    # Separate count and non-count features
    non_count_columns = [col for col in feature_columns if not col.endswith('_count')]
    count_columns = [col for col in feature_columns if col.endswith('_count')]

    for gender in genders:
        print(f"\n{'='*60}\nProcessing All Models for: {gender.upper()}\n{'='*60}")
        df = pd.DataFrame(all_profiles[gender])

        # Precompute medians for entire gender dataset
        gender_df = df.copy()
        gender_df[count_columns] = gender_df[count_columns].replace(-1, 0)
        gender_df[non_count_columns] = gender_df[non_count_columns].replace(-1, np.nan)
        gender_medians = gender_df[non_count_columns].median()

        # Save medians for inference
        medians_file = os.path.join(models_dir, f"{gender}-medians.json")
        with open(medians_file, 'w') as f:
            json.dump(gender_medians.to_dict(), f)
        print(f"💾 Saved {gender} medians to: {medians_file}")

        for stroke in strokes_to_predict:
            target_column = f"{stroke}_50m_best"
            print(f"\n--- Training {stroke.title()} Model for {gender.title()} ---")

            # Filter valid targets
            trainable_df = df[df[target_column] != -1].copy()
            if len(trainable_df) < 20:
                print(f"⚠️  Not enough data to train {stroke} model for {gender}. Skipping.")
                continue

            print(f"Found {len(trainable_df)} trainable samples")

            # Clean and impute data
            trainable_df[count_columns] = trainable_df[count_columns].replace(-1, 0)
            trainable_df[non_count_columns] = trainable_df[non_count_columns].replace(-1, np.nan)
            trainable_df[non_count_columns] = trainable_df[non_count_columns].fillna(gender_medians)

            X = trainable_df[feature_columns]
            y = trainable_df[target_column]

            # Train/test split
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=0.2, random_state=42
            )

            # Train and evaluate with LightGBM
            print("🤖 Training LightGBM model...")
            model = lgb.LGBMRegressor(**MODEL_CONFIG)
            model.fit(
                X_train, y_train,
                eval_set=[(X_test, y_test)],
                eval_metric='mae',
                callbacks=[lgb.early_stopping(stopping_rounds=20, verbose=0)]
            )

            print("📈 Evaluating model...")
            y_pred = model.predict(X_test)
            r2 = r2_score(y_test, y_pred)
            mae = mean_absolute_error(y_test, y_pred)
            print(f"  R²: {r2:.4f} | MAE: {mae:.2f}s")

            # Final model with all data
            print("✅ Retraining with full dataset...")
            final_model = lgb.LGBMRegressor(**MODEL_CONFIG)
            final_model.fit(X, y)

            # Export ONNX model
            print("🔄 Converting to ONNX...")
            initial_type = [('float_input', FloatTensorType([None, len(feature_columns)]))]
            onnx_model = onnxmltools.convert_lightgbm(final_model, initial_types=initial_type)

            model_path = os.path.join(models_dir, f"{stroke}-{gender}-model.onnx")
            with open(model_path, "wb") as f:
                f.write(onnx_model.SerializeToString())
            print(f"💾 Model saved to: {model_path}")

if __name__ == "__main__":
    create_all_models()
