"""
Generate a CSV file with 500,000 random profile rows for testing CSV ingestion.
Each run produces different names using UUID-based suffixes.

Usage:
    python scripts/generate_csv.py
    python scripts/generate_csv.py --rows 100000 --output test_small.csv
"""

import csv
import random
import uuid
import argparse
from pathlib import Path

GENDERS = ["male", "female"]

COUNTRIES = [
    ("NG", "Nigeria"),
    ("KE", "Kenya"),
    ("GH", "Ghana"),
    ("ZA", "South Africa"),
    ("EG", "Egypt"),
    ("US", "United States"),
    ("GB", "United Kingdom"),
    ("DE", "Germany"),
    ("FR", "France"),
    ("IN", "India"),
    ("BR", "Brazil"),
    ("MX", "Mexico"),
    ("JP", "Japan"),
    ("CN", "China"),
    ("AU", "Australia"),
    ("CA", "Canada"),
    ("IT", "Italy"),
    ("ES", "Spain"),
    ("PH", "Philippines"),
    ("PK", "Pakistan"),
]

FIRST_NAMES = [
    "Amara", "Chidi", "Fatima", "Kwame", "Ngozi", "Emeka", "Aisha", "Kofi",
    "Yemi", "Tunde", "Zara", "Malik", "Sade", "Olu", "Bisi", "Femi",
    "James", "Maria", "John", "Sarah", "Michael", "Emma", "David", "Olivia",
    "Daniel", "Sophia", "Matthew", "Isabella", "Andrew", "Mia", "Joshua",
    "Charlotte", "Ryan", "Amelia", "Nathan", "Harper", "Tyler", "Evelyn",
    "Arjun", "Priya", "Rahul", "Ananya", "Vikram", "Deepa", "Rohan", "Kavya",
    "Wei", "Mei", "Jun", "Ling", "Hao", "Xiu", "Feng", "Yan",
    "Carlos", "Sofia", "Miguel", "Valentina", "Diego", "Camila", "Luis", "Ana",
    "Yuki", "Hana", "Kenji", "Sakura", "Takeshi", "Aiko", "Hiroshi", "Yuna",
]

LAST_NAMES = [
    "Okafor", "Mensah", "Diallo", "Nkosi", "Osei", "Adeyemi", "Kamara",
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Sharma", "Patel", "Singh", "Kumar", "Gupta", "Verma",
    "Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang",
    "Silva", "Santos", "Oliveira", "Souza", "Costa", "Ferreira",
    "Tanaka", "Suzuki", "Watanabe", "Yamamoto", "Nakamura", "Kobayashi",
    "Mueller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer",
]


def age_group_from_age(age: int) -> str:
    if age <= 12:
        return "child"
    elif age <= 19:
        return "teenager"
    elif age <= 59:
        return "adult"
    else:
        return "senior"


def generate_row(index: int) -> dict:
    # Use index + short uuid suffix to guarantee uniqueness across runs
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)
    suffix = uuid.uuid4().hex[:6]
    name = f"{first} {last} {suffix}"

    gender = random.choice(GENDERS)
    age = random.randint(1, 85)
    age_group = age_group_from_age(age)
    country_id, country_name = random.choice(COUNTRIES)
    gender_probability = round(random.uniform(0.55, 0.99), 4)
    country_probability = round(random.uniform(0.10, 0.95), 4)

    return {
        "name": name,
        "gender": gender,
        "age": age,
        "age_group": age_group,
        "country_id": country_id,
        "country_name": country_name,
        "gender_probability": gender_probability,
        "country_probability": country_probability,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate test CSV for profile ingestion")
    parser.add_argument("--rows", type=int, default=500_000, help="Number of rows to generate")
    parser.add_argument("--output", type=str, default="test_profiles.csv", help="Output file path")
    args = parser.parse_args()

    output_path = Path(args.output)
    fieldnames = [
        "name", "gender", "age", "age_group",
        "country_id", "country_name",
        "gender_probability", "country_probability",
    ]

    print(f"Generating {args.rows:,} rows → {output_path}")

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for i in range(args.rows):
            writer.writerow(generate_row(i))

            if (i + 1) % 50_000 == 0:
                print(f"  {i + 1:,} rows written...")

    print(f"Done. File written to {output_path}")


if __name__ == "__main__":
    main()
