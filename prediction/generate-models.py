"""Deprecated. Use models.py instead."""

raise SystemExit("Use models.py to train prediction models.")
import os
import json
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score, mean_absolute_error
import skl2onnx
from skl2onnx.common.data_types import FloatTensorType

from model_config import (
    FEATURE_COLUMNS,
    GENDERS,
    MODELS_DIR,
    PROFILE_DATA_PATH,
    STROKES,
    clean_profile_frame,
    compute_feature_medians,
    prepare_training_data,
)

def create_all_models():
    print("🐍 Loading swimmer profile data...")
    os.makedirs(MODELS_DIR, exist_ok=True)

    with open(PROFILE_DATA_PATH, 'r') as f:
        all_profiles = json.load(f)

    MODEL_CONFIG = {
        "n_estimators": 100,
        "random_state": 42,
        "n_jobs": -1
    }

    for gender in GENDERS:
        print(f"\n{'='*60}\nProcessing All Models for: {gender.upper()}\n{'='*60}")
        df = pd.DataFrame(all_profiles[gender])

        clean_df = clean_profile_frame(df)
        gender_medians = compute_feature_medians(clean_df)

        # Save medians for inference
        medians_file = os.path.join(MODELS_DIR, f"{gender}-medians.json")
        with open(medians_file, 'w') as f:
            json.dump(gender_medians.to_dict(), f)
        print(f"💾 Saved {gender} medians to: {medians_file}")

        for stroke in STROKES:
            print(f"\n--- Training {stroke.title()} Model for {gender.title()} ---")

            X, y, dropped_rows = prepare_training_data(df, stroke, gender_medians)
            if len(X) < 20:
                print(f"⚠️  Not enough data to train {stroke} model for {gender}. Skipping.")
                continue

            print(f"Found {len(X)} trainable samples ({dropped_rows} rows missing target/source or outside ratio bounds)")

            # Train/test split
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=0.2, random_state=42
            )

            # Train and evaluate
            print("🤖 Training model...")
            model = RandomForestRegressor(**MODEL_CONFIG)
            model.fit(X_train, y_train)

            print("📈 Evaluating model...")
            y_pred = model.predict(X_test)
            r2 = r2_score(y_test, y_pred)
            mae = mean_absolute_error(y_test, y_pred)
            print(f"  R²: {r2:.4f} | MAE: {mae:.2f}s")

            # Final model with all data
            print("✅ Retraining with full dataset...")
            final_model = RandomForestRegressor(**MODEL_CONFIG)
            final_model.fit(X, y)

            # Export ONNX model
            print("🔄 Converting to ONNX...")
            initial_type = [('float_input', FloatTensorType([None, len(FEATURE_COLUMNS)]))]
            onnx_model = skl2onnx.convert_sklearn(final_model, initial_types=initial_type)

            model_path = os.path.join(MODELS_DIR, f"{stroke}-{gender}-model.onnx")
            with open(model_path, "wb") as f:
                f.write(onnx_model.SerializeToString())
            print(f"💾 Model saved to: {model_path}")

if __name__ == "__main__":
    create_all_models()
