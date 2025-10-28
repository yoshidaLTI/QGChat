import mlx_whisper

result = mlx_whisper.transcribe(
  speech_file,
  path_or_hf_repo="mlx-community/whisper-large-v3-mlx")
