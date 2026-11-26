-- Provisional condition list (M2.2, approved 2026-11-26). The final list is to be co-designed with
-- patient organisations (PRD). Codes are permanent: a label may be reworded and an entry switched
-- off (active = false) by a later migration, but a code is never deleted or reused, so stored
-- profiles always stay valid. Status (living with / in remission / survivor) is chosen separately.
-- "other" goes with the member's own words.
INSERT INTO vault.condition_taxonomy (code, label_en) VALUES
  ('hiv', 'HIV'),
  ('t1d', 'Type 1 diabetes'),
  ('t2d', 'Type 2 diabetes'),
  ('cancer', 'Cancer'),
  ('epilepsy', 'Epilepsy'),
  ('lupus', 'Lupus'),
  ('rheumatoid_arthritis', 'Rheumatoid arthritis'),
  ('multiple_sclerosis', 'Multiple sclerosis'),
  ('crohns_disease', 'Crohn''s disease'),
  ('ulcerative_colitis', 'Ulcerative colitis'),
  ('psoriasis', 'Psoriasis'),
  ('asthma', 'Asthma'),
  ('chronic_kidney_disease', 'Chronic kidney disease'),
  ('heart_condition', 'Heart condition'),
  ('high_blood_pressure', 'High blood pressure'),
  ('sickle_cell_disease', 'Sickle cell disease'),
  ('hepatitis_b', 'Hepatitis B'),
  ('hepatitis_c', 'Hepatitis C'),
  ('thyroid_condition', 'Thyroid condition'),
  ('endometriosis', 'Endometriosis'),
  ('chronic_pain', 'Fibromyalgia or chronic pain'),
  ('long_covid', 'Long COVID'),
  ('cystic_fibrosis', 'Cystic fibrosis'),
  ('other', 'Other (in my own words)');
