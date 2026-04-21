import os
import asyncio
import logging
import requests
import re
from typing import Optional

import uvicorn
import pandas as pd
import numpy as np
import joblib
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client
from dotenv import load_dotenv

from rating_engine import RatingEngine
from baseline import load_historical_baselines, get_baseline_rating

# ─── Load Local Environment Variables ────────────────────────────────────────
load_dotenv()

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("Server")

# ─── Supabase Setup ──────────────────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    logger.info("✅ Connected to Supabase Cloud!")
except Exception as e:
    logger.error(f"❌ Supabase Connection Failed: {e}")
    supabase = None

# ─── Global State ─────────────────────────────────────────────────────────────
GROUND_TRUTH_DB_PATH = "lc_users_dump.json"
_global_wednesday_db = load_historical_baselines(GROUND_TRUTH_DB_PATH)

try:
    logger.info("Loading XGBoost Production Model...")
    xgb_model = joblib.load('leetcode_xgboost_production.pkl')
    logger.info("✅ XGBoost Brain loaded successfully!")
except Exception as e:
    logger.warning(f"⚠️ Could not load XGBoost model: {e}")
    xgb_model = None

app = FastAPI(title="LeetCode Predictor API (Supabase + Live ML)")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# ─── In-Memory Cache ──────────────────────────────────────────────────────────
_prediction_cache: dict[str, list[dict]] = {}

# ─── Models ──────────────────────────────────────────────────────────────────
class ContestInfo(BaseModel):
    title: str
    slug: str
    startTime: int
    duration: int

class PredictionEntry(BaseModel):
    username: str
    global_rank: int
    score: int | None = None
    finish_time: int | None = None
    previous_rating: float
    predicted_delta: float
    predicted_rating: float

class PredictionResponse(BaseModel):
    contest_slug: str
    total_participants: int
    predictions: list[PredictionEntry]


# ─── Helper: The Math & ML Execution Core ─────────────────────────────────────
def calculate_predictions(raw_participants: list[dict], global_db: dict) -> list[dict]:
    """Runs the Elo Engine and XGBoost model on a set of participants."""
    # 1. Elo Math
    engine = RatingEngine()
    predictions = engine.calculate(raw_participants, {}, global_db)

    # 2. ML Ensemble
    if xgb_model is not None:
        df = pd.DataFrame(predictions)
        k_map = {p['username']: p.get('k', 0) for p in raw_participants}
        df['k_value'] = df['username'].map(k_map).fillna(0)

        valid_times = df[df['finish_time'] > 0]['finish_time']
        min_finish = valid_times.min() if not valid_times.empty else 0
        df['solve_time_seconds'] = (df['finish_time'] - min_finish).clip(lower=0)

        features = ['previous_rating', 'k_value', 'score', 'solve_time_seconds', 'global_rank']
        X = df[features].rename(columns={'previous_rating': 'old_rating', 'global_rank': 'actual_rank'})
        df['ml_delta'] = xgb_model.predict(X)

        conditions = [df['k_value'] < 5, df['k_value'] > 50, df['k_value'] > 15]
        math_weights = [0.8, 0.2, 0.3]
        ml_weights   = [0.2, 0.8, 0.7]

        df['w_math'] = np.select(conditions, math_weights, default=0.5)
        df['w_ml']   = np.select(conditions, ml_weights, default=0.5)

        df['ensemble_delta'] = (df['predicted_delta'] * df['w_math']) + (df['ml_delta'] * df['w_ml'])
        df['predicted_delta'] = df['ensemble_delta'].round(2)
        df['predicted_rating'] = (df['previous_rating'] + df['predicted_delta']).round(2)

        columns_to_drop = ['ml_delta', 'w_math', 'w_ml', 'ensemble_delta', 'solve_time_seconds', 'k_value']
        predictions = df.drop(columns=columns_to_drop, errors='ignore').to_dict(orient='records')
        
    return predictions

# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "db_connected": supabase is not None, "ml_ready": xgb_model is not None}


@app.get("/contests/latest", response_model=list[ContestInfo])
async def contests_latest():
    """Fetches ONLY the contests currently stored in your Supabase database."""
    if not supabase:
        raise HTTPException(status_code=500, detail="Database not configured.")
        
    try:
        # We specifically ONLY select the slug to keep this request blazing fast
        response = supabase.table("contest_predictions").select("contest_slug").execute()
        
        contests = []
        for row in response.data:
            slug = row.get("contest_slug", "")
            if not slug:
                continue
                
            # Automatically format "weekly-contest-498" -> "Weekly Contest 498"
            title = " ".join([word.capitalize() for word in slug.split("-")])
            
            contests.append(
                ContestInfo(
                    title=title,
                    slug=slug,
                    startTime=0,  # Not needed for the dropdown
                    duration=0
                )
            )
            
        # Sort them numerically so the highest number is always at the top of the dropdown
        def extract_number(s):
            match = re.search(r'\d+', s)
            return int(match.group()) if match else 0
            
        contests.sort(key=lambda c: extract_number(c.slug), reverse=True)
        
        return contests
        
    except Exception as e:
        logger.error(f"Error fetching contests from DB: {e}")
        raise HTTPException(status_code=500, detail="Could not fetch contest list.")


@app.get("/predict/{contest_slug}")
async def predict_contest(contest_slug: str, refresh: bool = Query(False)):
    """Fetches data from Supabase, performs Biweekly->Weekly cascade if needed, runs ML, and caches."""
    if not refresh and contest_slug in _prediction_cache:
        logger.info(f"⚡ Cache hit for {contest_slug}")
        return PredictionResponse(contest_slug=contest_slug, total_participants=len(_prediction_cache[contest_slug]), predictions=_prediction_cache[contest_slug])

    if not supabase:
        raise HTTPException(status_code=500, detail="Database not configured.")

    try:
        # 1. Fetch requested contest
        logger.info(f"☁️ Fetching raw data for {contest_slug} from Supabase...")
        res_target = supabase.table("contest_predictions").select("participant_data").eq("contest_slug", contest_slug).execute()
        
        if not res_target.data:
            raise HTTPException(status_code=404, detail=f"Contest '{contest_slug}' not yet available in the database.")
        target_participants = res_target.data[0].get("participant_data", [])

        # 2. CASCADE LOGIC: If this is a Weekly, check if we need Biweekly baseline adjustments
        cascade_cache = {}
        if "weekly-contest" in contest_slug:
            logger.info("🔍 Checking for recent Biweekly contest to perform Cascade Calculation...")
            # Fetch all stored slugs to find the most recent biweekly
            res_all = supabase.table("contest_predictions").select("contest_slug").execute()
            stored_slugs = [row["contest_slug"] for row in res_all.data]
            
            biweeklies = [s for s in stored_slugs if "biweekly-contest" in s]
            if biweeklies:
                # Sort alphabetically/numerically to get the latest biweekly available in DB
                latest_biweekly = sorted(biweeklies, reverse=True)[0]
                logger.info(f"🌊 Cascade Triggered! Calculating {latest_biweekly} first...")
                
                # If we haven't calculated the biweekly yet, do it now
                if latest_biweekly not in _prediction_cache:
                    res_bw = supabase.table("contest_predictions").select("participant_data").eq("contest_slug", latest_biweekly).execute()
                    if res_bw.data:
                        bw_participants = res_bw.data[0].get("participant_data", [])
                        bw_jit = {p["username"]: p.get("previous_rating", 1500.0) for p in bw_participants}
                        bw_db = {**_global_wednesday_db, **bw_jit}
                        bw_preds = calculate_predictions(bw_participants, bw_db)
                        _prediction_cache[latest_biweekly] = bw_preds
                
                # Extract the predicted ratings from the Biweekly to feed into the Weekly
                if latest_biweekly in _prediction_cache:
                    cascade_cache = {p["username"]: p["predicted_rating"] for p in _prediction_cache[latest_biweekly]}
                    logger.info(f"✅ Extracted {len(cascade_cache)} updated baseline ratings from {latest_biweekly}.")

        # 3. Apply Cascade & Baseline to Target Contest
        jit_ratings_only = {p["username"]: p.get("previous_rating", 1500.0) for p in target_participants}
        combined_db = {**_global_wednesday_db, **jit_ratings_only}

        # Override the official baselines with the Biweekly predictions for users who participated in both!
        if cascade_cache:
            overrides = 0
            for uname, new_rating in cascade_cache.items():
                if uname in combined_db:
                    combined_db[uname] = new_rating
                    overrides += 1
            logger.info(f"🔄 Applied Biweekly Cascade adjustments to {overrides} intersecting users.")

        # 4. Final Math & ML Execution
        logger.info(f"🧠 Running ML Prediction Engine for {contest_slug}...")
        final_predictions = calculate_predictions(target_participants, combined_db)

        # 5. Cache and Return
        _prediction_cache[contest_slug] = final_predictions
        logger.info(f"🎉 Successfully generated and cached {len(final_predictions)} predictions!")

        return PredictionResponse(
            contest_slug=contest_slug,
            total_participants=len(final_predictions),
            predictions=final_predictions
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Pipeline error for {contest_slug}: {e}")
        raise HTTPException(status_code=500, detail="Error processing data.")

@app.get("/predict/{contest_slug}/user/{username}")
async def predict_user(contest_slug: str, username: str):
    if contest_slug not in _prediction_cache:
        raise HTTPException(status_code=404, detail="Contest math not calculated yet. Call /predict/{contest_slug} first.")
    
    match = next((p for p in _prediction_cache[contest_slug] if p["username"].lower() == username.lower()), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"User '{username}' not found.")
    return match

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)