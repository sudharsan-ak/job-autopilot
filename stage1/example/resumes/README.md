# Example resume directory

A real private Stage 1 batch stores job-specific `.pdf` and `.tex` files here. They are intentionally omitted from this public example.

The manifest uses relative paths such as:

```text
resumes/Example Company - Frontend Engineer.pdf
```

When that file exists locally, Stage 2 prefers it. When it is absent, Stage 2 may use `STAGE2_DEFAULT_RESUME_PATH` and marks the queue row accordingly during import.
