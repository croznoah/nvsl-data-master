<?php
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST');
    header('Access-Control-Allow-Headers: Content-Type');

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        try {
            $input = json_decode(file_get_contents('php://input'), true);

            if (!$input || !isset($input['data'])) {
                throw new Exception('Invalid JSON data');
            }

            $jsonData = $input['data'];
            $filename = $input['filename'] ?? 'data.json';

            // Sanitize filename
            $filename = preg_replace('/[^a-zA-Z0-9._-]/', '', $filename);
            if (!$filename) $filename = 'data.json';

            // Save to files directory
            $filepath = 'files/' . $filename;

            // Create directory if it doesn't exist
            if (!is_dir('files')) {
                mkdir('files', 0755, true);
            }

            $jsonString = json_encode($jsonData, JSON_PRETTY_PRINT);
            $result = file_put_contents($filepath, $jsonString);

            if ($result === false) {
                throw new Exception('Failed to write file');
            }

            echo json_encode([
                'success' => true,
                'message' => 'File saved successfully',
                'filename' => $filename,
                'path' => $filepath,
                'size' => $result
            ]);

        } catch (Exception $e) {
            http_response_code(500);
            echo json_encode([
                'success' => false,
                'error' => $e->getMessage()
            ]);
        }
    } else {
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
    }
?>
