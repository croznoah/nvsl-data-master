import json
import os
import subprocess

def extract_freestyle_times(gender, stroke):
    script_dir = os.path.dirname(__file__)
    file_path = os.path.join(script_dir, "..", "files", "swimmer-profiles.json")

    with open(file_path, "r") as f:
        all_profiles = json.load(f)

    print_data = []
    for swimmer in all_profiles[gender]:
        a = swimmer["free_25m_best"]
        b = swimmer["back_25m_best"]
        c = swimmer["breast_25m_best"]
        d = swimmer["fly_25m_best"]
        y = swimmer["free_50m_best"]

        if d != -1 and y != -1:
            print_data.append((d, y))

    output_lines = []
    for x, y in print_data:
        output_lines.append(f"{x}\t{y}")

    output_string = "\n".join(output_lines)

    subprocess.run(["wl-copy"], input=output_string, text=True, check=True)
    print(f"Copied {len(print_data)} rows to clipboard")

extract_freestyle_times("boys", "free")
